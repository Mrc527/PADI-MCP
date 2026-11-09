/**
 * The GraphQL transport of the PADI logbook (Hasura on Postgres).
 *
 * Modes (PADI_API_MODE):
 * - "proxy" (default): POST to the logbook API gateway with Authorization, affiliate-id and
 *   x-platform; every document takes $affiliate_id.
 * - "direct": POST to the Hasura endpoint with Authorization and x-platform, plus
 *   x-hasura-role: user on writes; no affiliate-id header and no $affiliate_id.
 * - "auto": start with proxy. Switch to direct for the life of this client when the proxy answers
 *   404, 410 or 5xx twice in a row, or still 401 right after a successful refresh.
 *
 * On HTTP 401 or a GraphQL "invalid-jwt" error the token is refreshed once and the request sent
 * again (PADI did not handle it). Hasura errors (HTTP 200 with "errors") become UserFacingErrors
 * that name the field when possible.
 */

import { UserFacingError } from "../util/errors.js";
import type { ApiMode } from "./api.js";
import type { GraphqlDocument, ResolvedMode } from "./documents.js";
import type { PadiEndpoints } from "./endpoints.js";
import { bodySnippet, padiFetch, parseJson, readText, statusError } from "./http.js";
import type { PadiSession } from "./session.js";

export interface GraphqlErrorEntry {
  message?: string;
  extensions?: { code?: string; path?: string; [key: string]: unknown };
}

/** A GraphQL error from PADI. The message is safe to show. */
export class PadiGraphqlError extends UserFacingError {
  /** Hasura error code, for example "data-exception" or "invalid-jwt". */
  readonly code?: string;
  /** The field PADI complained about, when it can be told. */
  readonly field?: string;

  constructor(message: string, opts: { code?: string; field?: string } = {}) {
    super(message);
    this.name = "PadiGraphqlError";
    if (opts.code) this.code = opts.code;
    if (opts.field) this.field = opts.field;
  }
}

/** Postgres enum type names (as PADI declares them) and the tool field that sets each. */
const ENUM_FIELDS: Record<string, string> = {
  dive_type: "dive_type",
  suit: "suit",
  gas_mixture: "gas",
  currents: "current",
  current: "current",
  surge: "surge",
  status: "status",
  log_type: "log_type",
  log_course: "training.course",
  units: "units",
  weather: "weather",
  water_type: "water_type",
  body_of_water: "body_of_water",
  visibility: "visibility",
  wave_condition: "waves",
  weight_type: "weight_type",
  cylinder_type: "cylinder_type",
  feeling: "feeling",
};

function isAuthError(e: GraphqlErrorEntry): boolean {
  const code = e.extensions?.code ?? "";
  const message = e.message ?? "";
  return code === "invalid-jwt" || /JWTExpired|JWSError|Could not verify JWT|invalid-jwt/i.test(message);
}

/** Turn the "errors" of a Hasura answer into one safe error. */
export function graphqlError(errors: GraphqlErrorEntry[]): PadiGraphqlError {
  const first = errors.find((e) => e && typeof e === "object") ?? {};
  const code = typeof first.extensions?.code === "string" ? first.extensions.code : undefined;
  const raw = bodySnippet(typeof first.message === "string" ? first.message : "unknown error", 300);

  const enumMatch = raw.match(/invalid input value for enum ([a-z_]+): "([^"]*)"/i);
  if (enumMatch) {
    const type = enumMatch[1]!.toLowerCase();
    const field = ENUM_FIELDS[type] ?? type;
    return new PadiGraphqlError(`PADI does not accept "${enumMatch[2]}" for ${field}.`, { code: code ?? "data-exception", field });
  }
  if (/malformed array literal/i.test(raw) || /A string is expected for type: _text/i.test(raw)) {
    return new PadiGraphqlError("PADI did not accept a list value (equipment or skills).", { code: code ?? "data-exception", field: "equipment" });
  }
  const numMatch = raw.match(/invalid input syntax for (?:type )?([a-z ]+): "([^"]*)"/i);
  if (numMatch) return new PadiGraphqlError(`PADI does not accept the value "${numMatch[2]}" (${numMatch[1]}).`, { code: code ?? "data-exception" });
  if (code === "constraint-violation" || /violates foreign key|violates (unique|not-null|check) constraint/i.test(raw)) {
    return new PadiGraphqlError(`PADI refused the change (${raw}).`, code ? { code } : {});
  }
  if (code === "permission-error" || code === "access-denied") {
    return new PadiGraphqlError(`PADI refused the request: this dive or field is not available to your account (${raw}).`, { code });
  }
  if (code === "validation-failed" || code === "parse-failed") {
    return new PadiGraphqlError(`PADI did not understand the request (${raw}). The PADI logbook may have changed.`, { code });
  }
  return new PadiGraphqlError(`PADI answered with an error: ${raw}`, code ? { code } : {});
}

export interface GraphqlClientOptions {
  session: PadiSession;
  endpoints: PadiEndpoints;
  mode: ApiMode;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Backoff of the HTTP layer (tests use 0). */
  backoffMs?: number;
  log?: (m: string) => void;
}

export interface GraphqlRequestOptions {
  /** A mutation: never sent twice once it reached PADI; x-hasura-role on direct. */
  write: boolean;
}

/** Builds the document for a mode (the texts differ) and the user's affiliate id. */
export type DocumentBuilder = (mode: ResolvedMode, affiliateId: string) => GraphqlDocument;

/** The answer of a write: which mode sent it (for the affected_rows check). */
export interface GraphqlAnswer<T> {
  data: T;
  mode: ResolvedMode;
}

export class GraphqlClient {
  private resolved: ResolvedMode;
  private proxyFailures = 0;

  constructor(private readonly opts: GraphqlClientOptions) {
    this.resolved = opts.mode === "direct" ? "direct" : "proxy";
  }

  /** The transport in use now. */
  get mode(): ResolvedMode {
    return this.resolved;
  }

  /** "proxy", "direct", or "auto (proxy)" / "auto (direct)". */
  describeMode(): string {
    return this.opts.mode === "auto" ? `auto (${this.resolved})` : this.resolved;
  }

  private switchToDirect(reason: string): void {
    if (this.resolved === "direct") return;
    this.resolved = "direct";
    this.proxyFailures = 0;
    this.opts.log?.(`PADI logbook: switching to the direct API (${reason}).`);
  }

  /** Send a document; returns `data`. */
  async request<T>(build: DocumentBuilder, opts: GraphqlRequestOptions): Promise<T> {
    return (await this.send<T>(build, opts)).data;
  }

  /** Send a document; returns `data` and the mode that sent it. */
  async send<T>(build: DocumentBuilder, opts: GraphqlRequestOptions): Promise<GraphqlAnswer<T>> {
    const session = this.opts.session;
    let refreshed = false;
    let proxyRetried = false;

    for (;;) {
      const mode = this.resolved;
      const token = await session.idToken();
      const claims = await session.claims();
      const doc = build(mode, claims.affiliateId);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "x-platform": "web",
      };
      if (mode === "proxy") headers["affiliate-id"] = claims.affiliateId;
      else if (opts.write) headers["x-hasura-role"] = "user";

      const res = await padiFetch(
        mode === "direct" ? this.opts.endpoints.directUrl : this.opts.endpoints.logbookUrl,
        { method: "POST", headers, body: JSON.stringify({ query: doc.query, variables: doc.variables }) },
        {
          ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
          ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
          ...(this.opts.backoffMs !== undefined ? { backoffMs: this.opts.backoffMs } : {}),
          idempotent: !opts.write,
          what: "The PADI logbook",
        },
      );

      if (res.status === 401) {
        await readText(res);
        if (!refreshed) {
          // PADI did not handle the request: refresh once and send it again.
          await session.refreshNow(token);
          refreshed = true;
          continue;
        }
        if (this.opts.mode === "auto" && mode === "proxy") {
          this.switchToDirect("the proxy refused a fresh token");
          continue;
        }
        throw statusError("The PADI logbook", res);
      }

      const failing = res.status === 404 || res.status === 410 || res.status >= 500;
      if (failing && this.opts.mode === "auto" && mode === "proxy") {
        const text = await readText(res);
        this.proxyFailures++;
        // 404 and 410 mean PADI did not handle the request, so even a write can go again.
        const safeToResend = !opts.write || res.status === 404 || res.status === 410;
        if (this.proxyFailures >= 2) {
          this.switchToDirect(`the proxy answered HTTP ${res.status} twice in a row`);
          if (safeToResend) continue;
        } else if (safeToResend && !proxyRetried) {
          proxyRetried = true;
          continue;
        }
        throw statusError("The PADI logbook", res, text);
      }

      const text = await readText(res);
      const json = parseJson(text) as { data?: unknown; errors?: GraphqlErrorEntry[] } | undefined;
      const errors = Array.isArray(json?.errors) ? json.errors : undefined;

      if (errors?.length) {
        if (errors.some(isAuthError)) {
          if (!refreshed) {
            await session.refreshNow(token);
            refreshed = true;
            continue;
          }
          if (this.opts.mode === "auto" && mode === "proxy") {
            this.switchToDirect("the proxy refused a fresh token");
            continue;
          }
          throw new PadiGraphqlError("PADI did not accept the sign-in token. Sign in to PADI again.", { code: "invalid-jwt" });
        }
        if (mode === "proxy" && res.ok) this.proxyFailures = 0;
        throw graphqlError(errors);
      }
      if (!res.ok) throw statusError("The PADI logbook", res, text);
      if (!json || typeof json !== "object" || json.data === undefined || json.data === null) {
        throw new PadiGraphqlError("PADI answered without data. The PADI logbook may have changed.");
      }
      if (mode === "proxy") this.proxyFailures = 0;
      return { data: json.data as T, mode };
    }
  }
}

/** affected_rows of a mutation field, or undefined when it is missing. */
export function affectedRows(data: unknown, field: string): number | undefined {
  const node = (data as Record<string, unknown> | null | undefined)?.[field] as { affected_rows?: unknown } | null | undefined;
  const n = node?.affected_rows;
  return typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : undefined;
}
