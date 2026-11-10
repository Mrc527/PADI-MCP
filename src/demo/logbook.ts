/**
 * The in-memory PADI logbook of a demo account: a data holder (DemoLogbookStore) and a
 * LogbookBackend on top of it (DemoLogbookBackend). Nothing leaves the server.
 *
 * The store behaves like the PADI database behind the logbook API (Hasura on Postgres), table by
 * table: typed columns (numbers written as strings are stored as numbers, enum values are checked,
 * text[] columns take a Postgres array literal), dates written as MM/DD/YYYY and read as naive
 * date-times, child rows that an update does not create, and no cascade on delete. The backend
 * moves wire data only, like the real one: validation, unit conversion and the "locked dive" rule
 * belong to the LogbookService. The mock PADI API of the integration tests uses the same store.
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
import { NotFoundError, UserFacingError } from "../util/errors.js";
import {
  DEMO_ADDRESS,
  DEMO_AFFILIATE_ID,
  DEMO_INSTRUCTORS,
  DEMO_NAME,
  DEMO_SITES,
  sampleCertifications,
  sampleDives,
} from "./logbook-data.js";

/** Builds the sample dives for a reset at `now` (dates relative to today in `timeZone`). */
export type DemoSeed = (now: Date, timeZone: string) => WireLog[];

export interface DemoLogbookStoreOptions {
  /** When the sample data is made (default: the clock). */
  now?: Date;
  clock?: () => Date;
  timeZone?: string;
  /** The sample dives (default: the invented logbook of logbook-data.ts). */
  seed?: DemoSeed;
  /** The account the data belongs to (default: the demo diver's affiliate id). */
  affiliateId?: string;
}

// ---------------------------------------------------------------------------------------------
// Errors (shaped like the GraphQL errors of the PADI logbook API)
// ---------------------------------------------------------------------------------------------

/** Hasura error codes the store produces. */
export type DemoErrorCode = "data-exception" | "parse-failed" | "validation-failed" | "constraint-violation" | "permission-error";

/** A write the PADI database would refuse. `detail` is the database message. */
export class DemoPadiError extends UserFacingError {
  constructor(
    readonly code: DemoErrorCode,
    readonly detail: string,
  ) {
    super(`The logbook refused the change: ${detail}`);
    this.name = "DemoPadiError";
  }
}

// ---------------------------------------------------------------------------------------------
// Tables and columns
// ---------------------------------------------------------------------------------------------

/** The tables of a dive, by their database names. */
export type DemoTable = "logbook_logs" | "logbook_depth_time" | "logbook_conditions" | "logbook_equipment" | "logbook_experience" | "logbook_skills";

/** The child relation of logbook_logs for each child table, and back. */
export const CHILD_RELATION: Readonly<Record<Exclude<DemoTable, "logbook_logs">, ChildTable>> = {
  logbook_depth_time: "depth_times",
  logbook_conditions: "conditions",
  logbook_equipment: "equipment",
  logbook_experience: "experiences",
  logbook_skills: "skills",
};
export const CHILD_TABLE: Readonly<Record<ChildTable, Exclude<DemoTable, "logbook_logs">>> = {
  depth_times: "logbook_depth_time",
  conditions: "logbook_conditions",
  equipment: "logbook_equipment",
  experiences: "logbook_experience",
  skills: "logbook_skills",
};

type Column = "int" | "numeric" | "text" | "text[]" | "timestamp" | { enumName: string; values: readonly string[] };

const ENUMS = {
  log_type: ["Recreational", "Training"],
  status: ["Draft", "Publish", "Pending", "Resubmit", "Verified", "QR Code Verified"],
  dive_type: ["Boat", "BeachShore", "Other"],
  suit: ["NoExposure", "FullSuit_3mm", "FullSuit_5mm", "FullSuit_7mm", "Shorty", "SemiDrySuit", "DrySuit"],
  // Nitrox and Heliox are accepted by PADI but not offered by its web app.
  gas_mixture: ["Air", "Enriched_32", "Enriched_36", "Enriched_40", "Enriched", "Trimix", "Rebreather", "Nitrox", "Heliox"],
  currents: ["NoCurrent", "SomeCurrent", "MediumCurrent", "StrongCurrent"],
  // NoSurge is accepted by PADI but not offered by its web app.
  surge: ["SomeSurge", "MediumSurge", "BigSurge", "NoSurge"],
  units: ["Metric", "Imperial"],
} as const;

const enumColumn = (name: keyof typeof ENUMS): Column => ({ enumName: name, values: ENUMS[name] });

/**
 * Columns of each table. Only the columns known to be Postgres enums are checked as enums; the
 * others (water_type, weather, visibility, ...) are plain text as far as anyone knows.
 */
const COLUMNS: Readonly<Record<DemoTable, Readonly<Record<string, Column>>>> = {
  logbook_logs: {
    affiliate_id: "int",
    log_type: enumColumn("log_type"),
    log_course: "text",
    log_number: "int",
    dive_type: enumColumn("dive_type"),
    dive_title: "text",
    dive_date: "timestamp",
    dive_location: "text",
    memsys_member_number: "int",
    status: enumColumn("status"),
    adventure_dive: "text",
    created_date: "timestamp",
    update_date: "timestamp",
  },
  logbook_depth_time: { max_depth: "numeric", bottom_time: "int", time_in: "text", time_out: "text" },
  logbook_conditions: {
    water_type: "text",
    body_of_water: "text",
    weather: "text",
    air_temp: "numeric",
    surface_water_temp: "numeric",
    bottom_water_temp: "numeric",
    visibility: "text",
    visibility_distance: "numeric",
    wave_condition: "text",
    current: enumColumn("currents"),
    surge: enumColumn("surge"),
  },
  logbook_equipment: {
    suit_type: enumColumn("suit"),
    weight: "numeric",
    weight_type: "text",
    additional_equipment: "text[]",
    cylinder_type: "text",
    cylinder_size: "numeric",
    gas_mixture: enumColumn("gas_mixture"),
    oxygen: "int",
    nitrogen: "int",
    helium: "int",
    starting_pressure: "numeric",
    ending_pressure: "numeric",
  },
  logbook_experience: { feeling: "text", notes: "text", buddies: "text", dive_center: "text" },
  logbook_skills: { dive_skills: "text[]" },
};

/** The fields of one dive as the PADI web app reads them ("get one dive"). */
const FULL_FIELDS = [
  "id",
  "log_type",
  "log_course",
  "log_number",
  "dive_type",
  "dive_title",
  "dive_date",
  "dive_location",
  "memsys_member_number",
  "status",
  "adventure_dive",
] as const;
const SUMMARY_FIELDS = ["id", "log_type", "log_course", "log_number", "dive_title", "dive_date", "dive_location", "status"] as const;

/** Child row fields of the "get one dive" query (no id, no logs_id). */
const CHILD_FIELDS: Readonly<Record<ChildTable, readonly string[]>> = {
  depth_times: ["max_depth", "bottom_time", "time_in", "time_out"],
  skills: ["dive_skills"],
  conditions: Object.keys(COLUMNS.logbook_conditions),
  equipment: Object.keys(COLUMNS.logbook_equipment),
  experiences: Object.keys(COLUMNS.logbook_experience),
};

const CHILD_RELATIONS: readonly ChildTable[] = ["depth_times", "conditions", "equipment", "experiences", "skills"];

// ---------------------------------------------------------------------------------------------
// Value conversion (what Postgres does with the values Hasura passes on)
// ---------------------------------------------------------------------------------------------

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const INTEGER = /^[+-]?\d+$/;

function toNumber(table: string, column: string, value: unknown, integer: boolean): number | null {
  if (value === null || value === undefined) return null;
  const type = integer ? "integer" : "numeric";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      throw new DemoPadiError("data-exception", `invalid input syntax for type ${type}: "${value}" (${table}.${column})`);
    }
    return value;
  }
  if (typeof value === "string" && (integer ? INTEGER : NUMERIC).test(value.trim())) return Number(value.trim());
  throw new DemoPadiError("data-exception", `invalid input syntax for type ${type}: ${JSON.stringify(value)} (${table}.${column})`);
}

const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function pad(n: number | string, width = 2): string {
  return String(n).padStart(width, "0");
}

/** A timestamp as Postgres reads it (DateStyle MDY), stored as the naive form PADI returns. */
function toTimestamp(table: string, column: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const bad = () => new DemoPadiError("data-exception", `invalid input syntax for type timestamp: ${JSON.stringify(value)} (${table}.${column})`);
  if (typeof value !== "string") throw bad();
  const v = value.trim();
  let y: number, m: number, d: number, time = "00:00:00";
  const us = v.match(US_DATE);
  const iso = v.match(ISO_DATE);
  if (us) {
    [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
  } else if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (iso[4] !== undefined) {
      if (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59) throw bad();
      time = `${iso[4]}:${iso[5]}:${pad(iso[6] ?? "00")}`;
    }
  } else {
    throw bad();
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new DemoPadiError("data-exception", `date/time field value out of range: ${JSON.stringify(value)} (${table}.${column})`);
  }
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${time}`;
}

/** Parse a Postgres array literal such as {Hood,"Dive Light"} into its items. */
export function parseArrayLiteral(literal: string): string[] | undefined {
  const s = literal.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return undefined;
  const body = s.slice(1, -1);
  const items: string[] = [];
  if (!body.trim()) return items;
  let i = 0;
  while (i <= body.length) {
    while (body[i] === " ") i++;
    let item = "";
    let quoted = false;
    if (body[i] === '"') {
      quoted = true;
      i++;
      for (;;) {
        if (i >= body.length) return undefined;
        const ch = body[i]!;
        if (ch === "\\") {
          if (i + 1 >= body.length) return undefined;
          item += body[i + 1];
          i += 2;
        } else if (ch === '"') {
          i++;
          break;
        } else {
          item += ch;
          i++;
        }
      }
      while (body[i] === " ") i++;
    } else {
      while (i < body.length && body[i] !== ",") {
        const ch = body[i]!;
        if (ch === '"' || ch === "{" || ch === "}") return undefined;
        if (ch === "\\") {
          item += body[i + 1] ?? "";
          i += 2;
        } else {
          item += ch;
          i++;
        }
      }
      item = item.trim();
      if (!item) return undefined;
    }
    if (quoted || item.toUpperCase() !== "NULL") items.push(item);
    if (i >= body.length) break;
    if (body[i] !== ",") return undefined;
    i++;
    if (i >= body.length) return undefined;
  }
  return items;
}

function toTextArray(table: string, column: string, value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  // Hasura passes a text[] value as a string; a JSON list is a parse error.
  if (typeof value !== "string") throw new DemoPadiError("parse-failed", `A string is expected for type: _text (${table}.${column})`);
  const items = parseArrayLiteral(value);
  if (!items) throw new DemoPadiError("data-exception", `malformed array literal: ${JSON.stringify(value)} (${table}.${column})`);
  return items;
}

function convert(table: DemoTable, column: string, value: unknown): unknown {
  const type = COLUMNS[table][column];
  if (!type) throw new DemoPadiError("validation-failed", `field '${column}' not found in type: '${table}_set_input'`);
  if (value === undefined || value === null) return null;
  if (typeof type === "object") {
    if (typeof value !== "string" || !type.values.includes(value)) {
      throw new DemoPadiError("data-exception", `invalid input value for enum ${type.enumName}: ${JSON.stringify(value)}`);
    }
    return value;
  }
  switch (type) {
    case "int":
      return toNumber(table, column, value, true);
    case "numeric":
      return toNumber(table, column, value, false);
    case "timestamp":
      return toTimestamp(table, column, value);
    case "text[]":
      return toTextArray(table, column, value);
    case "text":
      if (typeof value !== "string") throw new DemoPadiError("parse-failed", `A string is expected for type: String (${table}.${column})`);
      return value;
  }
}

/** An SQL ILIKE pattern (% and _ wildcards, backslash escapes) as a regular expression. */
export function ilikeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") {
      out += "[\\s\\S]*";
    } else if (ch === "_") {
      out += "[\\s\\S]";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

type Row = Record<string, unknown> & { id: number; logs_id?: number };

function pick(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f] === undefined ? null : structuredClone(row[f]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/** One demo account's logbook data, kept in memory. */
export class DemoLogbookStore {
  readonly timeZone: string;
  readonly clock: () => Date;
  /** The account the data belongs to (logbook_logs.affiliate_id). */
  readonly affiliateId: number;
  private readonly seed: DemoSeed;
  /** Dives by id, with all columns and child rows (child rows keep their id and logs_id). */
  logs = new Map<number, WireLog>();
  /** The PADI display setting. */
  units: Units = "Metric";
  /** The invented dive site list (logbook_dive_site). */
  readonly sites: readonly DiveSite[] = DEMO_SITES;
  /** The demo diver's eCards. */
  certifications: Certification[] = [];
  nextId = 1;
  private nextChildId = 1;
  /** When the current sample data was made. */
  resetAt: Date;

  constructor(opts: DemoLogbookStoreOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.timeZone = opts.timeZone ?? "Europe/Zurich";
    this.seed = opts.seed ?? sampleDives;
    this.affiliateId = Number(opts.affiliateId ?? DEMO_AFFILIATE_ID);
    this.resetAt = opts.now ?? this.clock();
    this.reset(this.resetAt);
  }

  now(): Date {
    return this.clock();
  }

  /** Throw away every change: fresh sample data for `now`. */
  reset(now: Date = this.clock()): void {
    const dives = this.seed(now, this.timeZone);
    this.logs = new Map(dives.map((d) => [d.id, { ...structuredClone(d), affiliate_id: this.affiliateId }]));
    this.units = "Metric";
    this.certifications = sampleCertifications(now, this.timeZone);
    this.nextId = Math.max(0, ...dives.map((d) => d.id)) + 1;
    let maxChild = 0;
    for (const d of dives) for (const rel of CHILD_RELATIONS) for (const c of d[rel] ?? []) maxChild = Math.max(maxChild, c.id ?? 0);
    this.nextChildId = maxChild + 1;
    this.resetAt = now;
  }

  /** Run `fn` as one transaction: when it throws, every change it made is undone. */
  transaction<T>(fn: () => T): T {
    const logs = new Map([...this.logs].map(([id, log]) => [id, structuredClone(log)]));
    const { units, nextId, nextChildId } = this;
    try {
      return fn();
    } catch (error) {
      this.logs = logs;
      Object.assign(this, { units, nextId, nextChildId });
      throw error;
    }
  }

  /** The child rows of a dive in a table (the stored objects). */
  private children(log: WireLog, table: Exclude<DemoTable, "logbook_logs">): Row[] {
    const rel = CHILD_RELATION[table];
    if (!log[rel]) (log as unknown as Record<string, unknown>)[rel] = [];
    return log[rel] as unknown as Row[];
  }

  private newChild(table: Exclude<DemoTable, "logbook_logs">, logsId: number, values: Record<string, unknown>): Row {
    const row: Row = { id: this.nextChildId++, logs_id: logsId };
    for (const column of Object.keys(COLUMNS[table])) row[column] = null;
    for (const [column, value] of Object.entries(values)) {
      if (column === "logs_id" || column === "id") continue;
      row[column] = convert(table, column, value);
    }
    return row;
  }

  /**
   * insert_logbook_logs with nested child rows ({ data: {...} } or { data: [...] }). Returns the
   * new id and the number of rows written (the dive and its child rows).
   */
  insertLog(general: Record<string, unknown>): { id: number; affectedRows: number } {
    const id = this.nextId++;
    const log: Record<string, unknown> = { id };
    for (const column of Object.keys(COLUMNS.logbook_logs)) log[column] = null;
    for (const rel of CHILD_RELATIONS) log[rel] = [];
    let affectedRows = 1;
    for (const [key, value] of Object.entries(general)) {
      if ((CHILD_RELATIONS as readonly string[]).includes(key)) continue;
      if (key === "affiliate_id") {
        if (value !== null && value !== undefined && String(value) !== String(this.affiliateId)) {
          throw new DemoPadiError("permission-error", "check constraint of an insert permission has failed");
        }
        continue;
      }
      if (!(key in COLUMNS.logbook_logs)) throw new DemoPadiError("validation-failed", `field '${key}' not found in type: 'logbook_logs_insert_input'`);
      log[key] = convert("logbook_logs", key, value);
    }
    log.affiliate_id = this.affiliateId;
    for (const rel of CHILD_RELATIONS) {
      const nested = general[rel];
      if (nested === undefined || nested === null) continue;
      const data = typeof nested === "object" && "data" in nested ? (nested as { data: unknown }).data : undefined;
      if (data === undefined || data === null || typeof data !== "object") {
        throw new DemoPadiError("validation-failed", `expecting a value for non-nullable variable: 'data' (logbook_logs.${rel})`);
      }
      for (const values of Array.isArray(data) ? data : [data]) {
        (log[rel] as Row[]).push(this.newChild(CHILD_TABLE[rel], id, values as Record<string, unknown>));
        affectedRows++;
      }
    }
    this.logs.set(id, log as unknown as WireLog);
    return { id, affectedRows };
  }

  /**
   * update_<table>(where: { id } or { logs_id }, _set). Returns the number of rows changed: 0 for
   * an unknown dive, and 0 for a child table without a row (an update never creates one).
   */
  update(table: DemoTable, where: { id: number } | { logs_id: number }, set: Record<string, unknown>): number {
    if (table === "logbook_logs") {
      if (!("id" in where)) throw new DemoPadiError("validation-failed", "logbook_logs is updated by id");
      const log = this.logs.get(where.id) as unknown as Record<string, unknown> | undefined;
      // Check every value first: a refused value changes nothing.
      const values = this.logValues(set);
      if (!log) return 0;
      Object.assign(log, values);
      return 1;
    }
    if (!("logs_id" in where)) throw new DemoPadiError("validation-failed", `${table} is updated by logs_id`);
    const values: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(set)) {
      if (column === "id" || column === "logs_id") throw new DemoPadiError("validation-failed", `field '${column}' cannot be set in '${table}'`);
      values[column] = convert(table, column, value);
    }
    const log = this.logs.get(where.logs_id);
    if (!log) return 0;
    const rows = this.children(log, table);
    for (const row of rows) Object.assign(row, values);
    return rows.length;
  }

  private logValues(set: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(set)) {
      if (column === "id") throw new DemoPadiError("validation-failed", "field 'id' cannot be set in 'logbook_logs'");
      // PADI's own web app never sends log_type in an update (the newer API may refuse it).
      if (column === "log_type") throw new DemoPadiError("validation-failed", "field 'log_type' must not be sent in an update of 'logbook_logs'");
      if (column === "affiliate_id") {
        if (value !== null && value !== undefined && String(value) !== String(this.affiliateId)) {
          throw new DemoPadiError("permission-error", "check constraint of an update permission has failed");
        }
        continue;
      }
      values[column] = convert("logbook_logs", column, value);
    }
    return values;
  }

  /** insert_<child table>(objects: { logs_id, ... }). The dive must exist (foreign key). */
  insertChild(table: Exclude<DemoTable, "logbook_logs">, values: Record<string, unknown>): number {
    const logsId = toNumber(table, "logs_id", values.logs_id, true);
    const log = logsId === null ? undefined : this.logs.get(logsId);
    if (!log || logsId === null) {
      throw new DemoPadiError(
        "constraint-violation",
        `Foreign key violation. insert or update on table "${table}" violates foreign key constraint "${CHILD_RELATION[table].replace(/s$/, "")}_logs_id_fkey"`,
      );
    }
    this.children(log, table).push(this.newChild(table, logsId, values));
    return 1;
  }

  /**
   * delete_<table>(where: { id } or { logs_id }). Deleting a dive that still has child rows fails
   * (there is no cascade): delete the child tables first, as PADI's own app does.
   */
  delete(table: DemoTable, where: { id: number } | { logs_id: number }): number {
    if (table === "logbook_logs") {
      if (!("id" in where)) throw new DemoPadiError("validation-failed", "logbook_logs is deleted by id");
      const log = this.logs.get(where.id);
      if (!log) return 0;
      for (const rel of CHILD_RELATIONS) {
        if ((log[rel] ?? []).length > 0) {
          throw new DemoPadiError(
            "constraint-violation",
            `Foreign key violation. update or delete on table "logbook_logs" violates foreign key constraint "${rel.replace(/s$/, "")}_logs_id_fkey" on table "${CHILD_TABLE[rel]}"`,
          );
        }
      }
      this.logs.delete(where.id);
      return 1;
    }
    if (!("logs_id" in where)) throw new DemoPadiError("validation-failed", `${table} is deleted by logs_id`);
    const log = this.logs.get(where.logs_id);
    if (!log) return 0;
    const rows = this.children(log, table);
    const n = rows.length;
    rows.splice(0, n);
    return n;
  }

  /** The dives, newest first (dive_date, then id), or by the deepest / longest dive first. */
  sorted(orderBy: ListQuery["orderBy"] = "date"): WireLog[] {
    const byDate = (a: WireLog, b: WireLog) => (b.dive_date ?? "").localeCompare(a.dive_date ?? "") || b.id - a.id;
    const logs = [...this.logs.values()];
    if (orderBy === "max_depth" || orderBy === "bottom_time") {
      const key = orderBy;
      const max = (log: WireLog): number | null => {
        const values = (log.depth_times ?? []).map((r) => r[key]).filter((v) => v !== null && v !== undefined).map(Number);
        return values.length ? Math.max(...values) : null;
      };
      // Postgres sorts NULL first in a descending order: dives without depth or time come first.
      return logs.sort((a, b) => {
        const x = max(a);
        const y = max(b);
        if (x === null || y === null) return x === y ? byDate(a, b) : x === null ? -1 : 1;
        return y - x || byDate(a, b);
      });
    }
    return logs.sort(byDate);
  }

  /** A dive in the shape of the "get one dive" query (a copy). */
  full(log: WireLog): WireLog {
    const out = pick(log as unknown as Record<string, unknown>, FULL_FIELDS);
    for (const rel of CHILD_RELATIONS) {
      out[rel] = ((log[rel] ?? []) as unknown as Record<string, unknown>[]).map((row) => pick(row, CHILD_FIELDS[rel]));
    }
    return out as unknown as WireLog;
  }

  /** A dive in the shape of the list query (a copy), optionally with dive_type, depth and time. */
  summary(log: WireLog, withDepthTime = false): WireLog {
    const out = pick(log as unknown as Record<string, unknown>, SUMMARY_FIELDS);
    if (withDepthTime) {
      out.dive_type = log.dive_type ?? null;
      out.depth_times = (log.depth_times ?? []).map((row) => pick(row as unknown as Record<string, unknown>, ["max_depth", "bottom_time"]));
    }
    return out as unknown as WireLog;
  }
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

/** A LogbookBackend on a DemoLogbookStore. */
export class DemoLogbookBackend implements LogbookBackend {
  readonly kind = "demo" as const;

  constructor(readonly store: DemoLogbookStore) {}

  private filtered(filter: { logType?: LogType; status?: DiveStatus } = {}, orderBy?: ListQuery["orderBy"]): WireLog[] {
    return this.store
      .sorted(orderBy)
      .filter((log) => (filter.logType === undefined || log.log_type === filter.logType) && (filter.status === undefined || log.status === filter.status));
  }

  async listLogs(q: ListQuery): Promise<WireLog[]> {
    const offset = Math.max(0, q.offset ?? 0);
    const all = this.filtered({ ...(q.logType ? { logType: q.logType } : {}), ...(q.status ? { status: q.status } : {}) }, q.orderBy);
    const page = q.limit === null || q.limit === undefined ? all.slice(offset) : all.slice(offset, offset + Math.max(0, q.limit));
    return page.map((log) => (q.full ? this.store.full(log) : this.store.summary(log, q.withDepthTime === true)));
  }

  async countLogs(filter?: { logType?: LogType; status?: DiveStatus }): Promise<number> {
    return this.filtered(filter).length;
  }

  async totalBottomTime(): Promise<number | null> {
    let sum: number | null = null;
    for (const log of this.store.logs.values()) {
      for (const row of log.depth_times ?? []) {
        if (row.bottom_time !== null && row.bottom_time !== undefined) sum = (sum ?? 0) + Number(row.bottom_time);
      }
    }
    return sum;
  }

  async getLog(id: number): Promise<WireLog | undefined> {
    const log = this.store.logs.get(id);
    return log ? this.store.full(log) : undefined;
  }

  async insertLog(payload: WireLogInsert): Promise<number> {
    return this.store.transaction(() => this.store.insertLog(payload as unknown as Record<string, unknown>).id);
  }

  async updateLog(update: WireLogUpdate): Promise<void> {
    const { id } = update;
    const missing = new Set(update.missing ?? []);
    const children: Array<[ChildTable, Record<string, unknown> | undefined]> = [
      ["depth_times", update.depthTime],
      ["conditions", update.conditions],
      ["equipment", update.equipment],
      ["experiences", update.experience],
      ["skills", update.skills],
    ];
    this.store.transaction(() => {
      // Like the newer PADI API: an update that changes no dive is an error.
      if (this.store.update("logbook_logs", { id }, update.general) === 0) {
        throw new NotFoundError(`Dive ${id} was not found in the logbook (nothing was changed).`);
      }
      for (const [rel, values] of children) {
        if (values === undefined) continue;
        const table = CHILD_TABLE[rel];
        if (missing.has(rel)) this.store.insertChild(table, { ...values, logs_id: id });
        else this.store.update(table, { logs_id: id }, values);
      }
    });
  }

  async deleteLog(id: number): Promise<void> {
    this.store.transaction(() => {
      for (const table of ["logbook_depth_time", "logbook_skills", "logbook_conditions", "logbook_experience", "logbook_equipment"] as const) {
        this.store.delete(table, { logs_id: id });
      }
      if (this.store.delete("logbook_logs", { id }) === 0) {
        throw new NotFoundError(`Dive ${id} was not found in the logbook (nothing was deleted).`);
      }
    });
  }

  async searchSites(pattern: string, limit: number): Promise<DiveSite[]> {
    const re = ilikeToRegExp(pattern);
    return this.store.sites
      .filter((s) => re.test(s.name))
      .slice(0, Math.max(0, limit))
      .map((s) => ({ ...s }));
  }

  async getUnits(): Promise<Units> {
    return this.store.units;
  }

  async setUnits(units: Units): Promise<void> {
    this.store.units = checkUnits(units);
  }

  async lookupInstructor(memberNumber: string): Promise<InstructorMatch[]> {
    const n = memberNumber.trim();
    if (!/^\d+$/.test(n)) return [];
    const pro = DEMO_INSTRUCTORS.find((p) => p.memberNumber === Number(n));
    if (!pro) return [];
    const name = [pro.firstName, pro.middleInitial, pro.lastName].filter(Boolean).join(" ");
    return [{ memberNumber: pro.memberNumber, name }];
  }

  async listCertifications(): Promise<Certification[]> {
    return structuredClone(this.store.certifications);
  }

  async listPhotoIds(logId: number): Promise<string[]> {
    void logId;
    // The demo dives have no photos.
    return [];
  }

  async getPhoto(logId: number, photoId: string): Promise<{ data: Buffer; mimeType: string }> {
    throw new NotFoundError(`Photo ${photoId} of dive ${logId} was not found.`);
  }

  async getProfilePhoto(): Promise<ProfilePhoto | undefined> {
    // "Alex Demo" has no photo, and nothing is ever fetched for a demo account.
    return undefined;
  }

  async account(): Promise<PadiAccount> {
    return { affiliateId: String(this.store.affiliateId), email: DEMO_ADDRESS, name: DEMO_NAME, isPro: false, apiMode: "demo" };
  }

  async check(): Promise<BackendCheck> {
    return { ok: true, dives: this.store.logs.size, apiMode: "demo" };
  }

  async close(): Promise<void> {
    // The store outlives the backend (it is reset by the demo registry).
  }
}

/** A units value as the logbook_units_settings.unit enum accepts it. */
export function checkUnits(units: unknown): Units {
  if (typeof units !== "string" || !(ENUMS.units as readonly string[]).includes(units)) {
    throw new DemoPadiError("data-exception", `invalid input value for enum units: ${JSON.stringify(units)}`);
  }
  return units as Units;
}
