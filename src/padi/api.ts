/**
 * PadiApi: the LogbookBackend that talks to PADI (wire level, no validation, no unit conversion).
 *
 * Transport modes ("proxy", "direct", "auto") and the request rules are described in
 * docs/DESIGN.md section 4 and docs/padi-api.md section 3. The GraphQL texts are in documents.ts.
 */

import type {
  BackendCheck,
  Certification,
  ChildTable,
  DiveSite,
  DiveStatus,
  InstructorMatch,
  ListQuery,
  LogbookBackend,
  LogType,
  PadiAccount,
  ProfilePhoto,
  Units,
  WireLog,
  WireLogInsert,
  WireLogUpdate,
} from "../logbook/types.js";
import { NotFoundError, redact, UserFacingError } from "../util/errors.js";
import {
  affiliateVar,
  countDocument,
  deleteDocument,
  getDocument,
  insertChildrenDocument,
  insertDocument,
  listDocument,
  setUnitsDocument,
  siteSearchDocument,
  totalBottomTimeDocument,
  unitsDocument,
  updateDocument,
  type Selection,
  type UpdateKind,
} from "./documents.js";
import type { PadiEndpoints } from "./endpoints.js";
import { affectedRows, GraphqlClient, PadiGraphqlError } from "./graphql.js";
import { padiFetch, PadiHttpError, parseJson, readText, statusError } from "./http.js";
import { downloadProfilePhoto, PhotoLinkError, photoLinkFrom, sniffImageType, type HostLookup } from "./photo.js";
import type { PadiSession } from "./session.js";

/** The file type by its first bytes (moved to photo.ts; still exported here). */
export { sniffImageType };

export type ApiMode = "proxy" | "direct" | "auto";

export interface PadiApiOptions {
  session: PadiSession;
  endpoints: PadiEndpoints;
  apiMode: ApiMode;
  fetch?: typeof fetch;
  log?: (m: string) => void;
  /** Per request, default 20 s. */
  timeoutMs?: number;
  /** Backoff of the HTTP layer (tests use 0). */
  backoffMs?: number;
  /** DNS lookup for the profile photo's host (tests). */
  lookup?: HostLookup;
}

/** The eCard image on PADI's image CDN. */
export const ECARD_IMAGE_BASE = "https://res.cloudinary.com/padi/image/upload/f_auto/q_auto/f_auto/q_auto/CDN/global/ecards/";

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** "14-SEP-2024" (eCard) or "09/14/2024" to "2024-09-14"; anything else as it is. */
export function ecardDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const v = value.trim();
  const dmy = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmy && MONTHS[dmy[2]!.toUpperCase()]) return `${dmy[3]}-${MONTHS[dmy[2]!.toUpperCase()]}-${dmy[1]!.padStart(2, "0")}`;
  const mdy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1]!.padStart(2, "0")}-${mdy[2]!.padStart(2, "0")}`;
  const iso = v.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
  if (iso) return iso[1];
  return v;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** One eCard of the eCard API, or undefined when it has no title. */
export function toCertification(card: Record<string, unknown>): Certification | undefined {
  const title = text(card.cardTitle) ?? text(card.certificationName) ?? text(card.title);
  if (!title) return undefined;
  const stock = text(card.eCardStockID) ?? text(card.eCardStockId);
  const out: Certification = { title };
  const certDate = ecardDate(card.certDate);
  if (certDate) out.certDate = certDate;
  const fields: Array<[keyof Certification, unknown]> = [
    ["padiNumber", card.padiNumber],
    ["instructorName", card.instructorName],
    ["instructorNumber", card.instructorNumber],
    ["storeName", card.storeName],
    ["licenseId", card.licenseID ?? card.licenseId],
  ];
  for (const [key, value] of fields) {
    const v = text(value);
    if (v) out[key] = v;
  }
  if (stock && /^[A-Za-z0-9_-]{1,64}$/.test(stock)) out.cardImageUrl = `${ECARD_IMAGE_BASE}${stock}.jpg`;
  return out;
}

/** The eCards of an eCard API answer (an object with eCardInfo, or a plain list). */
export function certificationsFrom(json: unknown): Certification[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { eCardInfo?: unknown } | undefined)?.eCardInfo) ? (json as { eCardInfo: unknown[] }).eCardInfo : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map(toCertification)
    .filter((c): c is Certification => !!c);
}

/** The PADI Pros of an instructor lookup answer. Unknown numbers come back empty or below 0. */
export function instructorsFrom(json: unknown): InstructorMatch[] {
  const results = (json as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const out: InstructorMatch[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const n = Number(o.memberNumber);
    if (!Number.isFinite(n) || n <= 0) continue;
    const name = [text(o.firstName), text(o.middleInitial), text(o.lastName)].filter(Boolean).join(" ");
    out.push({ memberNumber: n, name });
  }
  return out;
}

/** Photo ids of a GetImageList answer: a list of ids, or of objects with an id. */
export function photoIdsFrom(json: unknown): string[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { images?: unknown } | undefined)?.images) ? (json as { images: unknown[] }).images : [];
  const out: string[] = [];
  for (const item of list) {
    const id =
      typeof item === "string" || typeof item === "number"
        ? text(item)
        : item && typeof item === "object"
          ? text((item as Record<string, unknown>).imageId ?? (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name)
          : undefined;
    if (id) out.push(id);
  }
  return out;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Make ids numbers (PADI may send them as strings). Everything else stays as PADI sent it. */
function normaliseLog(row: unknown): WireLog | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as WireLog & { id: unknown };
  const id = num(r.id);
  if (id === null) return undefined;
  return { ...r, id, log_number: num(r.log_number) };
}

function rows(data: unknown, field: string): unknown[] {
  const list = (data as Record<string, unknown> | null | undefined)?.[field];
  return Array.isArray(list) ? list : [];
}

/** The columns that never go into an update's _set. */
const NOT_IN_SET = new Set(["log_type", "created_date", "affiliate_id", "id"]);

export class PadiApi implements LogbookBackend {
  readonly kind = "padi" as const;
  private readonly gql: GraphqlClient;

  constructor(private readonly opts: PadiApiOptions) {
    this.gql = new GraphqlClient({
      session: opts.session,
      endpoints: opts.endpoints,
      mode: opts.apiMode,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  /** The transport in use ("auto" turns into "proxy" or "direct" once decided). */
  get apiMode(): ApiMode {
    return this.gql.mode;
  }

  /** The API mode for display, for example "auto (proxy)". */
  describeApiMode(): string {
    return this.gql.describeMode();
  }

  // -------------------------------------------------------------------------------------------
  // GraphQL
  // -------------------------------------------------------------------------------------------

  async listLogs(q: ListQuery): Promise<WireLog[]> {
    const selection: Selection = q.full ? "full" : q.withDepthTime ? "depth" : "summary";
    const order = q.orderBy ?? "date";
    if (q.logType && q.status) {
      // PADI filters by one of them only: filter the status here, then page.
      const all = await this.listLogs({ ...q, status: undefined, limit: null, offset: 0 } as ListQuery);
      const filtered = all.filter((d) => d.status === q.status);
      const start = q.offset ?? 0;
      return q.limit === null || q.limit === undefined ? filtered.slice(start) : filtered.slice(start, start + q.limit);
    }
    const data = await this.gql.request<unknown>(
      (mode, aff) =>
        listDocument(mode, aff, {
          limit: q.limit ?? null,
          offset: q.offset ?? 0,
          ...(q.logType ? { logType: q.logType } : {}),
          ...(q.status ? { status: q.status } : {}),
          order,
          selection,
        }),
      { write: false },
    );
    return rows(data, "logbook_logs")
      .map(normaliseLog)
      .filter((r): r is WireLog => !!r);
  }

  async countLogs(filter: { logType?: LogType; status?: DiveStatus } = {}): Promise<number> {
    if (filter.logType && filter.status) {
      return (await this.listLogs({ limit: null, logType: filter.logType, status: filter.status })).length;
    }
    const data = await this.gql.request<{ logbook_logs_aggregate?: { aggregate?: { count?: unknown } } }>((mode, aff) => countDocument(mode, aff, filter), {
      write: false,
    });
    const count = num(data.logbook_logs_aggregate?.aggregate?.count);
    if (count === null) throw new PadiGraphqlError("PADI did not answer the dive count. The PADI logbook may have changed.");
    return count;
  }

  async totalBottomTime(): Promise<number | null> {
    const data = await this.gql.request<{ logbook_depth_time_aggregate?: { aggregate?: { sum?: { bottom_time?: unknown } } } }>(
      (mode, aff) => totalBottomTimeDocument(mode, aff),
      { write: false },
    );
    return num(data.logbook_depth_time_aggregate?.aggregate?.sum?.bottom_time);
  }

  async getLog(id: number): Promise<WireLog | undefined> {
    const data = await this.gql.request<unknown>((mode, aff) => getDocument(mode, aff, id), { write: false });
    const found = rows(data, "logbook_logs").map(normaliseLog).find((r) => r?.id === id);
    return found;
  }

  async insertLog(payload: WireLogInsert): Promise<number> {
    const answer = await this.gql.send<{ insert_logbook_logs?: { affected_rows?: unknown; returning?: Array<{ id?: unknown }> } }>(
      // The affiliate id always comes from the token, never from the caller.
      (mode, aff) => insertDocument(mode, { ...payload, affiliate_id: affiliateVar(aff) }),
      { write: true },
    );
    const inserted = answer.data.insert_logbook_logs;
    const id = num(inserted?.returning?.[0]?.id);
    if (affectedRows(answer.data, "insert_logbook_logs") === 0 || id === null) {
      throw new PadiGraphqlError("PADI did not save the dive (no row was added).");
    }
    return id;
  }

  async updateLog(update: WireLogUpdate): Promise<void> {
    const missing = new Set<ChildTable>(update.missing ?? []);
    const general: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(update.general)) if (!NOT_IN_SET.has(key)) general[key] = value;
    const training = typeof general.log_course === "string" && general.log_course !== "";
    const withSkills = update.skills !== undefined && !missing.has("skills");
    const kind: UpdateKind = withSkills ? "training" : training ? "training_without_skills" : "recreational";

    const answer = await this.gql.send<Record<string, unknown>>(
      (mode, aff) =>
        updateDocument(mode, kind, {
          id: update.id,
          general: { ...general, affiliate_id: affiliateVar(aff) },
          depthTime: update.depthTime,
          conditions: update.conditions,
          equipment: update.equipment,
          experience: update.experience,
          ...(withSkills ? { skills: update.skills } : {}),
        }),
      { write: true },
    );
    if (affectedRows(answer.data, "update_logbook_logs") === 0) {
      throw new NotFoundError(`PADI did not change dive ${update.id}: it does not exist or is not yours.`);
    }

    // Child rows that do not exist yet are not created by an update: insert them.
    const childRows: Partial<Record<ChildTable, Record<string, unknown>>> = {};
    const source: Record<ChildTable, Record<string, unknown> | undefined> = {
      depth_times: update.depthTime,
      conditions: update.conditions,
      equipment: update.equipment,
      experiences: update.experience,
      skills: update.skills,
    };
    for (const rel of missing) {
      const row = source[rel];
      if (row) childRows[rel] = { ...row, logs_id: update.id };
    }
    if (Object.keys(childRows).length) {
      await this.gql.request<unknown>(() => insertChildrenDocument(childRows), { write: true });
    }
  }

  async deleteLog(id: number): Promise<void> {
    const answer = await this.gql.send<Record<string, unknown>>((mode) => deleteDocument(mode, id), { write: true });
    if (affectedRows(answer.data, "delete_logbook_logs") === 0) {
      throw new NotFoundError(`PADI did not delete dive ${id}: it does not exist or is not yours.`);
    }
  }

  async searchSites(pattern: string, limit: number): Promise<DiveSite[]> {
    const data = await this.gql.request<unknown>(() => siteSearchDocument(pattern), { write: false });
    const out: DiveSite[] = [];
    for (const row of rows(data, "logbook_dive_site")) {
      const r = row as { id?: unknown; name?: unknown } | null;
      const id = num(r?.id);
      const name = typeof r?.name === "string" ? r.name.trim() : "";
      if (id !== null && name) out.push({ id, name });
      if (out.length >= limit) break;
    }
    return out;
  }

  async getUnits(): Promise<Units> {
    const data = await this.gql.request<unknown>((mode, aff) => unitsDocument(mode, aff), { write: false });
    const unit = (rows(data, "logbook_units_settings")[0] as { unit?: unknown } | undefined)?.unit;
    return unit === "Imperial" ? "Imperial" : "Metric";
  }

  async setUnits(units: Units): Promise<void> {
    const answer = await this.gql.send<{ insert_logbook_units_settings?: { returning?: unknown[] } }>((_mode, aff) => setUnitsDocument(aff, units), {
      write: true,
    });
    const returning = answer.data.insert_logbook_units_settings?.returning;
    if (answer.mode === "direct" && (!Array.isArray(returning) || returning.length === 0)) {
      throw new PadiGraphqlError("PADI did not save the units setting.");
    }
  }

  // -------------------------------------------------------------------------------------------
  // REST
  // -------------------------------------------------------------------------------------------

  /**
   * A GET with the bearer token; refreshes once on HTTP 401. `noRedirect`: a redirect is not
   * followed but answered as it is (an HTTP 3xx, so the caller's status check fails), so the
   * headers never go to another host.
   */
  private async get(url: string, what: string, headers: { affiliate: boolean; platform: boolean; accept?: string; noRedirect?: boolean }): Promise<Response> {
    const session = this.opts.session;
    let refreshed = false;
    for (;;) {
      const token = await session.idToken();
      const h: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: headers.accept ?? "application/json" };
      if (headers.affiliate) h["affiliate-id"] = (await session.claims()).affiliateId;
      if (headers.platform) h["x-platform"] = "web";
      const res = await padiFetch(
        url,
        { method: "GET", headers: h, ...(headers.noRedirect ? { redirect: "manual" as const } : {}) },
        {
          ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
          ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
          ...(this.opts.backoffMs !== undefined ? { backoffMs: this.opts.backoffMs } : {}),
          what,
        },
      );
      if (res.status === 401 && !refreshed) {
        await readText(res);
        await session.refreshNow(token);
        refreshed = true;
        continue;
      }
      return res;
    }
  }

  private async getJson(url: string, what: string, headers: { affiliate: boolean; platform: boolean }): Promise<{ status: number; json: unknown }> {
    const res = await this.get(url, what, headers);
    const body = await readText(res);
    if (res.status === 404) return { status: 404, json: undefined };
    if (!res.ok) throw statusError(what, res, body);
    return { status: res.status, json: parseJson(body) };
  }

  async lookupInstructor(memberNumber: string): Promise<InstructorMatch[]> {
    const n = memberNumber.trim();
    if (!/^\d{1,12}$/.test(n)) return [];
    const base = this.gql.mode === "direct" ? this.opts.endpoints.directInstructorUrl : this.opts.endpoints.instructorUrl;
    const { json } = await this.getJson(`${base}/${encodeURIComponent(n)}`, "The PADI instructor lookup", { affiliate: true, platform: true });
    return instructorsFrom(json);
  }

  async listCertifications(): Promise<Certification[]> {
    const claims = await this.opts.session.claims();
    const op = claims.isPro ? "GetAlleCardListPro" : "GeteCardListConsumer";
    const { json } = await this.getJson(`${this.opts.endpoints.ecardUrl}/${op}`, "The PADI eCard service", { affiliate: true, platform: false });
    return certificationsFrom(json);
  }

  async listPhotoIds(logId: number): Promise<string[]> {
    const { json } = await this.getJson(`${this.opts.endpoints.imagesUrl}/GetImageList/${encodeURIComponent(String(logId))}`, "The PADI photo service", {
      affiliate: true,
      platform: false,
    });
    return photoIdsFrom(json);
  }

  async getPhoto(logId: number, photoId: string): Promise<{ data: Buffer; mimeType: string }> {
    const url = `${this.opts.endpoints.imagesUrl}/GetImage/${encodeURIComponent(String(logId))}/${encodeURIComponent(photoId)}`;
    // The PADI web app sends this one without the affiliate-id header.
    const res = await this.get(url, "The PADI photo service", { affiliate: false, platform: false, accept: "image/*" });
    if (res.status === 404) {
      await readText(res);
      throw new NotFoundError(`Photo ${photoId} of dive ${logId} was not found.`);
    }
    if (!res.ok) throw statusError("The PADI photo service", res, await readText(res));
    const data = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    // The bytes win over the header when they are a known image (servers send "image/jpg" and the like).
    const sniffed = sniffImageType(data);
    return { data, mimeType: sniffed !== "application/octet-stream" || !type.startsWith("image/") ? sniffed : type };
  }

  async getProfilePhoto(opts: { note?: (reason: string) => void } = {}): Promise<ProfilePhoto | undefined> {
    const note = opts.note ?? (() => undefined);
    const base = this.opts.endpoints.photoUrl;
    if (!base) {
      note("no PADI photo address (the PADI addresses point to a test server)");
      return undefined;
    }
    // Step 1: which photo. The PADI web app sends this with the affiliate-id header. A redirect
    // is not followed (that header would go to the other host): it fails like an HTTP error.
    const what = "The PADI photo service";
    const res = await this.get(`${base}?status=approved`, what, { affiliate: true, platform: false, noRedirect: true });
    const body = await readText(res);
    if (!res.ok) throw statusError(what, res, body);
    const json = parseJson(body);
    // A page that is not JSON at all (an empty answer, a maintenance or firewall page) says
    // nothing about the photo: the check failed, so the stored photo stays and is asked for again later.
    if (json === undefined) throw new PadiHttpError("http", `${what} did not answer JSON.`);
    const found = photoLinkFrom(json);
    if ("none" in found) {
      note(found.none);
      return undefined;
    }
    // Step 2: the photo itself, from a storage host, without the token. An http photo address
    // is the operator's local mock (tests): only then may the link be http or local.
    try {
      return await downloadProfilePhoto(found.link, {
        allowLocal: new URL(base).protocol === "http:",
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
      });
    } catch (error) {
      if (error instanceof PhotoLinkError && error.final) {
        note(error.reason);
        return undefined;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------------------------

  async account(): Promise<PadiAccount> {
    const session = this.opts.session;
    const claims = await session.claims();
    const expires = session.tokenExpiresAt;
    const method = session.loginMethod;
    return {
      affiliateId: claims.affiliateId,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.name ? { name: claims.name } : {}),
      isPro: claims.isPro,
      ...(method ? { loginMethod: method } : {}),
      apiMode: this.gql.describeMode(),
      ...(expires ? { tokenExpiresAt: new Date(expires).toISOString() } : {}),
    };
  }

  async check(): Promise<BackendCheck> {
    try {
      const dives = await this.countLogs();
      return { ok: true, dives, apiMode: this.gql.describeMode() };
    } catch (error) {
      const message = error instanceof UserFacingError ? error.message : `Error: ${(error as Error)?.message ?? String(error)}`;
      return { ok: false, error: redact(message, []), apiMode: this.gql.describeMode() };
    }
  }

  async close(): Promise<void> {
    // Nothing to close: every request is a plain fetch.
  }
}
