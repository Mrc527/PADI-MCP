/**
 * LogbookService: everything between the MCP tools and a LogbookBackend.
 *
 * It validates input (the zod shapes below are shared with the tools), converts units, merges an
 * update into the stored dive (read, merge, write), refuses locked dives (Pending, Verified,
 * QR Code Verified), checks confirmations, computes statistics and builds exports. The backend
 * only moves wire data. Writes of one service instance run one after another.
 */

import { z } from "zod";
import { NotFoundError, ReadOnlyError, UserFacingError } from "../util/errors.js";
import { parseDateOnly, todayInZone } from "../util/dates.js";
import {
  ADVENTURE_DIVES,
  ADVENTURE_ELECTIVE_NUMBERS,
  allowedSkills,
  canonicalEquipment,
  describeEnum,
  enumKey,
  GAS_PRESETS,
  isEnumValue,
  parseAdventureDive,
  parseEnum,
  SKILL_COURSES,
  TRAINING_DIVES,
  trainingDive,
  type EnumKind,
  type EnumValue,
} from "./enums.js";
import {
  applyPatch,
  buildInsert,
  buildUpdate,
  emptyState,
  isLocked,
  stateFromWire,
  toDive,
  toDiveSummary,
  type DiveState,
} from "./mapping.js";
import type {
  BackendCheck,
  Certification,
  Dive,
  DiveInput,
  DivePatch,
  DiveSite,
  DiveStatus,
  DiveSummary,
  DiveUnits,
  LogbookBackend,
  LogType,
  PadiAccount,
  TrainingCourse,
  UnitChoice,
  Units,
  UnitSystem,
  WireLog,
  WireLogInsert,
} from "./types.js";
import { formatMinutes, round, toMetric, unitLabels, unitOf, type Quantity } from "./units.js";

export interface LogbookServiceOptions {
  readOnly: boolean;
  /** Units of answers and of unit-bearing inputs when a call names none. "auto": the PADI setting. */
  units: UnitChoice;
  /** IANA time zone for "today" (dates in the future are refused). */
  timeZone: string;
  /** The clock, for tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------
// Arguments and results
// ---------------------------------------------------------------------------------------------

export type SortKey = "date" | "max_depth" | "bottom_time";
export type StatsGroupBy = "none" | "year" | "month" | "location" | "dive_type" | "log_type";

export interface ListDivesArgs {
  /** 1-100, default 15. */
  limit?: number;
  offset?: number;
  log_type?: LogType;
  status?: DiveStatus;
  sort?: SortKey;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Text in the title, location or buddies. */
  query?: string;
}

export interface ListDivesResult {
  total: number;
  dives: DiveSummary[];
  next_offset?: number;
  units: DiveUnits;
}

export interface GetDiveArgs {
  dive_id: number;
  units?: UnitChoice;
}

export interface StatsArgs {
  from?: string;
  to?: string;
  group_by?: StatsGroupBy;
  units?: UnitChoice;
}

export interface DiveRef {
  dive_id: number;
  title: string;
  date: string;
  location: string;
}

export interface StatsSummary {
  count: number;
  total_bottom_time_min: number;
  /** h:mm */
  total_bottom_time: string;
  deepest?: DiveRef & { max_depth: number };
  longest?: DiveRef & { bottom_time_min: number };
  average_max_depth?: number;
  average_bottom_time_min?: number;
  first_dive?: string;
  last_dive?: string;
}

export interface StatsResult extends StatsSummary {
  units: DiveUnits;
  from?: string;
  to?: string;
  group_by: StatsGroupBy;
  groups?: Array<StatsSummary & { key: string }>;
}

export interface SearchSitesArgs {
  query: string;
  /** 1-50, default 20. */
  limit?: number;
}

export interface SearchSitesResult {
  sites: DiveSite[];
  /** Free text that is not in the list is also accepted as a dive location. */
  note?: string;
}

export interface CreateDiveArgs extends DiveInput {
  units?: UnitChoice;
}

export interface UpdateDiveArgs extends DivePatch {
  dive_id: number;
  units?: UnitChoice;
}

export interface DeleteDiveArgs {
  dive_id: number;
  /** Must equal the dive title (trimmed, case-insensitive). */
  confirm_title: string;
}

export interface DeleteDiveResult {
  deleted: true;
  /** The deleted dive, so it can be created again. */
  dive: Dive;
}

export interface SubmitForVerificationArgs {
  dive_id: number;
  instructor_number: string;
  confirm: true;
}

export interface InstructorInfo {
  member_number: string;
  found: boolean;
  name?: string;
}

export interface SubmitForVerificationResult {
  dive: Dive;
  instructor: InstructorInfo;
}

export interface UnitsResult {
  /** The PADI logbook display setting. */
  padi_setting: Units;
  /** Units this server uses for answers when a call names none. */
  effective: UnitSystem;
}

export interface GetPhotosArgs {
  dive_id: number;
  /** 1-5, default 3. */
  max?: number;
}

export interface DivePhoto {
  id: string;
  mimeType: string;
  data: Buffer;
}

export interface GetPhotosResult {
  dive_id: number;
  total: number;
  photos: DivePhoto[];
  /** Photos left out (too large, or over `max`). */
  skipped?: number;
}

export interface ExportArgs {
  format: "csv" | "json";
  from?: string;
  to?: string;
  units?: UnitChoice;
}

export interface ExportResult {
  format: "csv" | "json";
  count: number;
  units: DiveUnits;
  content: string;
}

export type CheckResult = BackendCheck;

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/** How long the PADI units setting is cached for "auto". */
export const UNITS_CACHE_MS = 5 * 60_000;
/** Largest photo returned (bytes). */
export const MAX_PHOTO_BYTES = 1_500_000;
/** Largest total of photos in one answer (bytes). */
export const MAX_PHOTOS_TOTAL_BYTES = 4_000_000;
/** PADI's own limit for depth, time and other numbers. */
const PADI_MAX_NUMBER = 999_999;

// ---------------------------------------------------------------------------------------------
// Input shapes (zod v4), shared with the tools
// ---------------------------------------------------------------------------------------------

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const diveId = z.number().int().positive().describe("The dive id (from logbook_list_dives)");
const unitChoice = z
  .enum(["auto", "metric", "imperial"])
  .describe("Units of the numbers in this call and its answer: metric (m, C, bar, kg, litres), imperial (ft, F, psi, lb, cubic feet) or auto (the PADI logbook setting). Default: the account setting.");

/** A lenient enum input: any spelling parseEnum knows. "none" style inputs become undefined. */
function enumInput<K extends EnumKind>(kind: K, what: string) {
  return z
    .string()
    .max(60)
    .transform((value, ctx): EnumValue<K> | undefined => {
      const parsed = parseEnum(kind, value);
      if (parsed === undefined) {
        ctx.addIssue({ code: "custom", message: `Unknown ${what} "${value}". Use one of: ${describeEnum(kind)}` });
        return z.NEVER;
      }
      return parsed ?? undefined;
    });
}

/** Like enumInput, for updates: null (or "none") clears the field. */
function enumPatch<K extends EnumKind>(kind: K, what: string) {
  return z
    .string()
    .max(60)
    .transform((value, ctx): EnumValue<K> | null => {
      const parsed = parseEnum(kind, value);
      if (parsed === undefined) {
        ctx.addIssue({ code: "custom", message: `Unknown ${what} "${value}". Use one of: ${describeEnum(kind)}` });
        return z.NEVER;
      }
      return parsed;
    })
    .nullable();
}

/** Status of a new or changed dive: Publish or Draft (lenient spelling). */
const writableStatus = z
  .string()
  .max(20)
  .transform((value, ctx): "Publish" | "Draft" => {
    const parsed = parseEnum("status", value);
    if (parsed === "Publish" || parsed === "Draft") return parsed;
    ctx.addIssue({ code: "custom", message: `Use Publish (logged) or Draft. To send a dive to a PADI Pro, use logbook_submit_for_verification.` });
    return z.NEVER;
  })
  .describe("Publish (a logged dive, the default) or Draft (incomplete: depth and time may be missing)");

const num = (min: number, max: number) => z.number().min(min).max(max);
const text = (max: number) => z.string().max(max);
const equipmentList = z.array(z.string().trim().min(1).max(50)).max(20);
const skillList = z.array(z.string().trim().min(1).max(100)).max(20);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const D = {
  title: "Dive title, for example the site name. Training dives (except Specialty) get the PADI course title instead",
  date: "Dive date YYYY-MM-DD (a calendar date, not in the future, at most 100 years ago)",
  location: "Dive site or place (free text; logbook_search_dive_sites lists PADI's site names)",
  dive_type: `Dive type: ${describeEnum("dive_type")}. "shore" and "beach" mean BeachShore`,
  max_depth: "Maximum depth, in m (metric) or ft (imperial). Needed unless the dive is a Draft",
  bottom_time_min: "Bottom time in whole minutes. Needed unless the dive is a Draft",
  time_in: "Time in, HH:MM (not verified with PADI yet; PADI's web app does not show it)",
  time_out: "Time out, HH:MM (not verified with PADI yet; PADI's web app does not show it)",
  water_type: `Water: ${describeEnum("water_type")}`,
  body_of_water: `Body of water: ${describeEnum("body_of_water")}`,
  weather: `Weather: ${describeEnum("weather")}`,
  air_temp: "Air temperature, in C (metric) or F (imperial)",
  surface_water_temp: "Water temperature at the surface, in C (metric) or F (imperial)",
  bottom_water_temp: "Water temperature at depth, in C (metric) or F (imperial)",
  visibility: `Visibility: ${describeEnum("visibility")}`,
  visibility_distance: "Visibility distance, in m (metric) or ft (imperial)",
  waves: `Waves: ${describeEnum("waves")}`,
  current: `Current: ${describeEnum("current")}. "light" means SomeCurrent`,
  surge: `Surge: ${describeEnum("surge")}. "strong" means BigSurge; "none" means no surge`,
  suit: `Exposure suit: ${describeEnum("suit")}. "3mm" means FullSuit_3mm`,
  weight: "Weight carried, in kg (metric) or lb (imperial)",
  weight_type: `How the weighting felt: ${describeEnum("weight_type")}`,
  equipment: "Extra equipment, for example [\"Hood\", \"Gloves\", \"Boots\"] (PADI offers these three; other items are allowed)",
  cylinder_type: `Cylinder material: ${describeEnum("cylinder_type")}`,
  cylinder_size: "Cylinder size: litres of water volume (metric) or cubic feet (imperial, converted the way the PADI web app does)",
  gas: `Breathing gas: ${describeEnum("gas")}. "EAN32" or "nitrox 32" means Enriched_32. Air and EANx32/36/40 fill the percentages; Enriched, Trimix and Rebreather need oxygen_pct (and helium_pct for Trimix), summing to 100 with nitrogen`,
  oxygen_pct: "Oxygen in %, 0-100 (whole numbers)",
  nitrogen_pct: "Nitrogen in %, 0-100 (default: the rest to 100)",
  helium_pct: "Helium in %, 0-100 (default 0)",
  start_pressure: "Cylinder pressure at the start, in bar (metric) or psi (imperial)",
  end_pressure: "Cylinder pressure at the end, in bar (metric) or psi (imperial)",
  feeling: `How the dive felt: ${describeEnum("feeling")}`,
  notes: "Notes (free text)",
  buddies: "Buddies (one free-text field, for example \"Sam, Kim\")",
  dive_center: "Dive center or operator (free text)",
} as const;

export const listDivesShape = {
  limit: z.number().int().min(1).max(100).optional().describe("Dives per page, 1-100 (default 15)"),
  offset: z.number().int().min(0).optional().describe("Dives to skip (use next_offset of the previous page)"),
  log_type: enumInput("log_type", "log type").optional().describe(`Only these dives: ${describeEnum("log_type")}`),
  status: enumInput("status", "status").optional().describe(`Only dives with this status: ${describeEnum("status")}`),
  sort: z.enum(["date", "max_depth", "bottom_time"]).optional().describe("Order, always descending: date (newest first, default), max_depth (deepest first) or bottom_time (longest first)"),
  from: dateOnly.optional().describe("Only dives on or after this date (YYYY-MM-DD)"),
  to: dateOnly.optional().describe("Only dives on or before this date (YYYY-MM-DD)"),
  query: z.string().trim().min(1).max(200).optional().describe("Only dives with this text in the title, location or buddies"),
};

export const getDiveShape = { dive_id: diveId, units: unitChoice.optional() };

export const statsShape = {
  from: dateOnly.optional().describe("Only dives on or after this date (YYYY-MM-DD)"),
  to: dateOnly.optional().describe("Only dives on or before this date (YYYY-MM-DD)"),
  group_by: z.enum(["none", "year", "month", "location", "dive_type", "log_type"]).optional().describe("Also give the numbers per year, month, location, dive type or log type (default none)"),
  units: unitChoice.optional(),
};

export const searchSitesShape = {
  query: z.string().trim().min(1).max(100).describe("Part of a dive site name"),
  limit: z.number().int().min(1).max(50).optional().describe("Most sites to return, 1-50 (default 20)"),
};

export const exportShape = {
  format: z.enum(["csv", "json"]).describe("csv (a table, one row per dive) or json (a list of full dives)"),
  from: dateOnly.optional().describe("Only dives on or after this date (YYYY-MM-DD)"),
  to: dateOnly.optional().describe("Only dives on or before this date (YYYY-MM-DD)"),
  units: unitChoice.optional(),
};

const memberNumber = z.string().trim().regex(/^\d{1,12}$/, "Digits only");

export const lookupInstructorShape = { member_number: memberNumber.describe("The PADI Pro's member number (digits only)") };

export const getPhotosShape = { dive_id: diveId, max: z.number().int().min(1).max(5).optional().describe("Most photos to return, 1-5 (default 3)") };

export const setUnitsShape = { units: z.enum(["metric", "imperial"]).describe("metric (m, C, bar, kg, litres) or imperial (ft, F, psi, lb, cubic feet)") };

export const submitForVerificationShape = {
  dive_id: diveId,
  instructor_number: memberNumber.describe("Member number of the PADI Pro who should verify (sign) the dive"),
  confirm: z.literal(true).describe("Must be true: the user agreed to send this dive to the PADI Pro"),
};

export const deleteDiveShape = {
  dive_id: diveId,
  confirm_title: z.string().min(1).max(500).describe("The dive's title, exactly as in the logbook (case does not matter), to confirm the delete. For a dive without a title: its id"),
};

const trainingShape = z
  .strictObject({
    course: enumInput("course", "course").pipe(z.custom<TrainingCourse>((v) => v !== undefined, "Give a course")).describe(`Course: ${describeEnum("course")}`),
    log_number: z
      .number()
      .int()
      .min(0)
      .max(13)
      .nullable()
      .optional()
      .describe("Training dive number: Open 1-4, Advanced 5 (Deep), 6 (Navigation), 7-9 (electives), Rescue 10-11, DSD 12, Reactivate 13. Leave out for Specialty"),
    adventure_dive: z.string().trim().min(1).max(80).optional().describe(`Advanced elective dives 7-9 only: ${ADVENTURE_DIVES.join(", ")}`),
    skills: skillList.optional().describe("Skills done. Open, Rescue and Reactivate: from PADI's list (for example \"no skills\", \"cramp removal\", \"swim compass\"). Specialty: one free-text entry (the specialty)"),
  })
  .describe("Only for training dives (saved as Draft; then use logbook_submit_for_verification)");

export const createDiveShape = {
  title: z.string().trim().min(1).max(200).describe(D.title),
  date: dateOnly.describe(D.date),
  location: z.string().trim().min(1).max(200).describe(D.location),
  dive_type: enumInput("dive_type", "dive type").pipe(z.custom<EnumValue<"dive_type">>((v) => v !== undefined, "Give a dive type")).describe(D.dive_type),
  status: writableStatus.optional(),
  max_depth: num(0, PADI_MAX_NUMBER).optional().describe(D.max_depth),
  bottom_time_min: z.number().int().min(0).max(PADI_MAX_NUMBER).optional().describe(D.bottom_time_min),
  time_in: timeOfDay.optional().describe(D.time_in),
  time_out: timeOfDay.optional().describe(D.time_out),
  water_type: enumInput("water_type", "water type").optional().describe(D.water_type),
  body_of_water: enumInput("body_of_water", "body of water").optional().describe(D.body_of_water),
  weather: enumInput("weather", "weather").optional().describe(D.weather),
  air_temp: num(-100, 200).optional().describe(D.air_temp),
  surface_water_temp: num(-100, 200).optional().describe(D.surface_water_temp),
  bottom_water_temp: num(-100, 200).optional().describe(D.bottom_water_temp),
  visibility: enumInput("visibility", "visibility").optional().describe(D.visibility),
  visibility_distance: num(0, PADI_MAX_NUMBER).optional().describe(D.visibility_distance),
  waves: enumInput("waves", "waves").optional().describe(D.waves),
  current: enumInput("current", "current").optional().describe(D.current),
  surge: enumInput("surge", "surge").optional().describe(D.surge),
  suit: enumInput("suit", "suit").optional().describe(D.suit),
  weight: num(0, PADI_MAX_NUMBER).optional().describe(D.weight),
  weight_type: enumInput("weight_type", "weighting").optional().describe(D.weight_type),
  equipment: equipmentList.optional().describe(D.equipment),
  cylinder_type: enumInput("cylinder_type", "cylinder type").optional().describe(D.cylinder_type),
  cylinder_size: num(0, PADI_MAX_NUMBER).optional().describe(D.cylinder_size),
  gas: enumInput("gas", "gas").optional().describe(D.gas),
  oxygen_pct: z.number().int().min(0).max(100).optional().describe(D.oxygen_pct),
  nitrogen_pct: z.number().int().min(0).max(100).optional().describe(D.nitrogen_pct),
  helium_pct: z.number().int().min(0).max(100).optional().describe(D.helium_pct),
  start_pressure: num(0, PADI_MAX_NUMBER).optional().describe(D.start_pressure),
  end_pressure: num(0, PADI_MAX_NUMBER).optional().describe(D.end_pressure),
  feeling: enumInput("feeling", "feeling").optional().describe(D.feeling),
  notes: text(10_000).optional().describe(D.notes),
  buddies: text(500).optional().describe(D.buddies),
  dive_center: text(200).optional().describe(D.dive_center),
  training: trainingShape.optional(),
  units: unitChoice.optional(),
};

const CLEAR = " (null clears it)";

export const updateDiveShape = {
  dive_id: diveId,
  title: z.string().trim().min(1).max(200).optional().describe("New title"),
  date: dateOnly.optional().describe(D.date),
  location: z.string().trim().min(1).max(200).optional().describe("New location"),
  dive_type: enumInput("dive_type", "dive type").pipe(z.custom<EnumValue<"dive_type">>((v) => v !== undefined, "Give a dive type")).optional().describe(D.dive_type),
  status: writableStatus.optional(),
  max_depth: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.max_depth + CLEAR),
  bottom_time_min: z.number().int().min(0).max(PADI_MAX_NUMBER).nullable().optional().describe(D.bottom_time_min + CLEAR),
  time_in: timeOfDay.nullable().optional().describe(D.time_in + CLEAR),
  time_out: timeOfDay.nullable().optional().describe(D.time_out + CLEAR),
  water_type: enumPatch("water_type", "water type").optional().describe(D.water_type + CLEAR),
  body_of_water: enumPatch("body_of_water", "body of water").optional().describe(D.body_of_water + CLEAR),
  weather: enumPatch("weather", "weather").optional().describe(D.weather + CLEAR),
  air_temp: num(-100, 200).nullable().optional().describe(D.air_temp + CLEAR),
  surface_water_temp: num(-100, 200).nullable().optional().describe(D.surface_water_temp + CLEAR),
  bottom_water_temp: num(-100, 200).nullable().optional().describe(D.bottom_water_temp + CLEAR),
  visibility: enumPatch("visibility", "visibility").optional().describe(D.visibility + CLEAR),
  visibility_distance: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.visibility_distance + CLEAR),
  waves: enumPatch("waves", "waves").optional().describe(D.waves + CLEAR),
  current: enumPatch("current", "current").optional().describe(D.current + CLEAR),
  surge: enumPatch("surge", "surge").optional().describe(D.surge + CLEAR),
  suit: enumPatch("suit", "suit").optional().describe(D.suit + CLEAR),
  weight: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.weight + CLEAR),
  weight_type: enumPatch("weight_type", "weighting").optional().describe(D.weight_type + CLEAR),
  equipment: equipmentList.nullable().optional().describe(D.equipment + ". Replaces the whole list" + CLEAR),
  cylinder_type: enumPatch("cylinder_type", "cylinder type").optional().describe(D.cylinder_type + CLEAR),
  cylinder_size: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.cylinder_size + CLEAR),
  gas: enumPatch("gas", "gas").optional().describe(D.gas + CLEAR),
  oxygen_pct: z.number().int().min(0).max(100).nullable().optional().describe(D.oxygen_pct + CLEAR),
  nitrogen_pct: z.number().int().min(0).max(100).nullable().optional().describe(D.nitrogen_pct + CLEAR),
  helium_pct: z.number().int().min(0).max(100).nullable().optional().describe(D.helium_pct + CLEAR),
  start_pressure: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.start_pressure + CLEAR),
  end_pressure: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.end_pressure + CLEAR),
  feeling: enumPatch("feeling", "feeling").optional().describe(D.feeling + CLEAR),
  notes: text(10_000).nullable().optional().describe(D.notes + CLEAR),
  buddies: text(500).nullable().optional().describe(D.buddies + CLEAR),
  dive_center: text(200).nullable().optional().describe(D.dive_center + CLEAR),
  adventure_dive: z.string().trim().min(1).max(80).nullable().optional().describe(`Adventure dive (Advanced elective dives 7-9): ${ADVENTURE_DIVES.join(", ")}` + CLEAR),
  skills: skillList.nullable().optional().describe("Training dives only: the skills done (replaces the list)" + CLEAR),
  units: unitChoice.optional(),
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Unit-bearing fields of a dive and their quantity. */
const UNIT_FIELDS: ReadonlyArray<[keyof DivePatch, Quantity]> = [
  ["max_depth", "depth"],
  ["visibility_distance", "depth"],
  ["air_temp", "temp"],
  ["surface_water_temp", "temp"],
  ["bottom_water_temp", "temp"],
  ["weight", "weight"],
  ["cylinder_size", "volume"],
  ["start_pressure", "pressure"],
  ["end_pressure", "pressure"],
];

/** Values a PADI enum field accepts, by DivePatch field. */
const ENUM_FIELDS: ReadonlyArray<[keyof DivePatch, EnumKind]> = [
  ["dive_type", "dive_type"],
  ["water_type", "water_type"],
  ["body_of_water", "body_of_water"],
  ["weather", "weather"],
  ["visibility", "visibility"],
  ["waves", "waves"],
  ["current", "current"],
  ["surge", "surge"],
  ["suit", "suit"],
  ["weight_type", "weight_type"],
  ["cylinder_type", "cylinder_type"],
  ["gas", "gas"],
  ["feeling", "feeling"],
];

function fail(problems: string[]): never {
  throw new UserFacingError(problems.length === 1 ? problems[0]! : `Please fix:\n- ${problems.join("\n- ")}`);
}

/** "YYYY-MM-DD" n years before a date (Feb 29 becomes Feb 28). */
function yearsBefore(date: string, years: number): string {
  const { year, month, day } = parseDateOnly(date);
  const d = month === 2 && day === 29 ? 28 : day;
  return `${String(year - years).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function inRange(date: string, from?: string, to?: string): boolean {
  if (!date) return !from && !to;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function checkRange(from?: string, to?: string): void {
  if (from) parseDateOnly(from);
  if (to) parseDateOnly(to);
  if (from && to && from > to) throw new UserFacingError(`"from" (${from}) is after "to" (${to}).`);
}

/** A CSV cell (RFC 4180). Text that a spreadsheet would run as a formula gets a leading quote. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let s = Array.isArray(value) ? value.join("; ") : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function describeLocked(dive: { id: number; status: string | null | undefined }, action: string): string {
  const status = dive.status ?? "";
  const why = status === "Pending" ? "it is waiting for verification by a PADI Pro" : `it is ${status}`;
  return `Dive ${dive.id} cannot be ${action}: ${why}. Locked dives (Pending, Verified, QR Code Verified) can only be changed on learning.padi.com, if at all.`;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export class LogbookService {
  private unitsCache: { value: Units; at: number } | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    readonly backend: LogbookBackend,
    readonly opts: LogbookServiceOptions,
  ) {}

  get readOnly(): boolean {
    return this.opts.readOnly;
  }

  /** Every write calls this first. */
  assertWritable(action: string = "change the logbook"): void {
    if (this.opts.readOnly) throw new ReadOnlyError(action);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private today(): string {
    return todayInZone(this.opts.timeZone, this.now());
  }

  /** Writes of this service run one after another. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async padiUnits(fresh = false): Promise<Units> {
    const at = this.now().getTime();
    if (!fresh && this.unitsCache && at - this.unitsCache.at < UNITS_CACHE_MS) return this.unitsCache.value;
    const value = await this.backend.getUnits();
    this.unitsCache = { value, at };
    return value;
  }

  /** The unit system of a call: its own choice, else the account setting ("auto": PADI's). */
  async resolveUnits(choice?: UnitChoice): Promise<UnitSystem> {
    const c = choice ?? this.opts.units;
    if (c === "metric" || c === "imperial") return c;
    try {
      return (await this.padiUnits()) === "Imperial" ? "imperial" : "metric";
    } catch {
      // The setting is display only: without it, answer in metric (what PADI stores).
      return "metric";
    }
  }

  private async existing(id: number): Promise<WireLog> {
    const dive = await this.backend.getLog(id);
    if (!dive) throw new NotFoundError(`Dive ${id} was not found in your PADI logbook.`);
    return dive;
  }

  // -------------------------------------------------------------------------------------------
  // Input normalisation and validation
  // -------------------------------------------------------------------------------------------

  /** A change in the call's units, as a metric change with canonical text values. */
  private metricPatch(patch: DivePatch, system: UnitSystem): DivePatch {
    const out: Record<string, unknown> = { ...patch };
    for (const [field, quantity] of UNIT_FIELDS) {
      const v = out[field];
      if (typeof v === "number") out[field] = toMetric(quantity, v, system);
    }
    for (const [field, kind] of ENUM_FIELDS) {
      const v = out[field];
      if (typeof v === "string" && !isEnumValue(kind, v)) {
        const parsed = parseEnum(kind, v);
        if (parsed === undefined) fail([`Unknown ${field} "${v}". Use one of: ${describeEnum(kind)}`]);
        out[field] = parsed;
      }
    }
    for (const field of ["title", "location"] as const) if (typeof out[field] === "string") out[field] = (out[field] as string).trim();
    for (const field of ["notes", "buddies", "dive_center"] as const) {
      if (typeof out[field] === "string" && !(out[field] as string).trim()) out[field] = null;
    }
    if (Array.isArray(out.equipment)) {
      const seen = new Set<string>();
      out.equipment = (out.equipment as string[]).map(canonicalEquipment).filter((item) => {
        const key = enumKey(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (typeof out.adventure_dive === "string") {
      const parsed = parseAdventureDive(out.adventure_dive);
      if (!parsed) fail([`Unknown adventure_dive "${out.adventure_dive}". Use one of: ${ADVENTURE_DIVES.join(", ")}`]);
      out.adventure_dive = parsed;
    }
    return out as DivePatch;
  }

  /** Fill and check the gas percentages (in place). */
  private normaliseGas(s: DiveState, problems: string[]): void {
    const pcts = [s.oxygen_pct, s.nitrogen_pct, s.helium_pct];
    if (!s.gas) {
      if (pcts.some((p) => p !== null && p > 0)) problems.push("Gas percentages need a gas: set gas too (for example Enriched for a custom nitrox, or Trimix).");
      return;
    }
    const preset = GAS_PRESETS[s.gas as keyof typeof GAS_PRESETS];
    if (preset) {
      const given = { oxygen: s.oxygen_pct, nitrogen: s.nitrogen_pct, helium: s.helium_pct };
      const differs = (Object.keys(preset) as Array<keyof typeof preset>).some((k) => given[k] !== null && given[k] !== preset[k]);
      if (differs) {
        problems.push(`${s.gas} is ${preset.oxygen}% oxygen, ${preset.nitrogen}% nitrogen and ${preset.helium}% helium. For another mix use gas Enriched or Trimix.`);
        return;
      }
      s.oxygen_pct = preset.oxygen;
      s.nitrogen_pct = preset.nitrogen;
      s.helium_pct = preset.helium;
      return;
    }
    if (!isEnumValue("gas", s.gas)) return; // A value PADI has that this server does not know: leave it.
    if (s.oxygen_pct === null || s.oxygen_pct <= 0) {
      problems.push(`Gas ${s.gas} needs oxygen_pct (and helium_pct for Trimix); oxygen, nitrogen and helium must add up to 100.`);
      return;
    }
    if (s.helium_pct === null) s.helium_pct = 0;
    if (s.nitrogen_pct === null) s.nitrogen_pct = 100 - s.oxygen_pct - s.helium_pct;
    const sum = s.oxygen_pct + s.nitrogen_pct + s.helium_pct;
    if (s.nitrogen_pct < 0 || Math.abs(sum - 100) > 0.001) {
      problems.push(`Oxygen, nitrogen and helium must add up to 100 (now ${round(sum, 3)}).`);
    }
  }

  /** The rules of the PADI web form, on a merged state. Throws one error listing every problem. */
  private validate(s: DiveState, opts: { checkDate: boolean; system: UnitSystem }): void {
    const problems: string[] = [];
    if (!s.title.trim()) problems.push("A title is needed.");
    if (!s.location.trim()) problems.push("A location is needed.");
    if (!s.dive_type) problems.push(`A dive type is needed: ${describeEnum("dive_type")}.`);
    if (opts.checkDate) {
      try {
        parseDateOnly(s.date);
        const today = this.today();
        if (s.date > today) problems.push(`The date ${s.date} is in the future (today is ${today}).`);
        else if (s.date < yearsBefore(today, 100)) problems.push(`The date ${s.date} is more than 100 years ago.`);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    if (s.status !== "Draft") {
      const missing = [s.max_depth === null ? "max_depth" : "", s.bottom_time_min === null ? "bottom_time_min" : ""].filter(Boolean);
      if (missing.length) problems.push(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} needed unless the dive is saved as a Draft.`);
    }
    if (s.bottom_time_min !== null && !Number.isInteger(s.bottom_time_min)) problems.push("bottom_time_min must be whole minutes.");
    const temp = (field: keyof DiveState, min: number, max: number) => {
      const v = s[field] as number | null;
      if (v !== null && (v < min || v > max)) {
        const unit = unitOf("temp", opts.system);
        problems.push(`${field} looks wrong for ${unit === "C" ? "degrees C" : "degrees F"}. Check the value and the units.`);
      }
    };
    temp("air_temp", -60, 60);
    temp("surface_water_temp", -5, 45);
    temp("bottom_water_temp", -5, 45);
    if (s.start_pressure !== null && s.end_pressure !== null && s.end_pressure > s.start_pressure) {
      problems.push("end_pressure is higher than start_pressure.");
    }
    this.normaliseGas(s, problems);

    if (s.log_type === "Training") {
      const course = s.course as TrainingCourse;
      if (!isEnumValue("course", course)) {
        problems.push(`Unknown course "${s.course ?? ""}". Use one of: ${describeEnum("course")}`);
      } else {
        if (course !== "SpecialtyAndDistinctive") {
          const ok = s.log_number !== null && trainingDive(course, s.log_number);
          if (!ok) {
            const numbers = TRAINING_DIVES[course].map((d) => d.log_number).join(", ");
            problems.push(`${course} training dives have log_number ${numbers}.`);
          }
        }
        const elective = s.log_number !== null && ADVENTURE_ELECTIVE_NUMBERS.includes(s.log_number) && course === "Advanced";
        if (s.adventure_dive && !elective) problems.push("adventure_dive is only for Advanced elective dives (log_number 7, 8 or 9).");
        if (elective && !s.adventure_dive && s.status !== "Draft") problems.push(`Advanced elective dives need adventure_dive: ${ADVENTURE_DIVES.join(", ")}.`);
        const skills = s.skills ?? [];
        if (course === "SpecialtyAndDistinctive") {
          if (skills.length > 1) problems.push("A Specialty dive takes one skill entry: the specialty, for example [\"Dry suit\"].");
        } else if (!SKILL_COURSES.includes(course)) {
          if (skills.length) problems.push(`${course} dives do not store skills.`);
        } else {
          const allowed = allowedSkills(course, s.log_number);
          const unknown = skills.filter((k) => !allowed.includes(k));
          if (unknown.length) problems.push(`Unknown skill${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `"${u}"`).join(", ")}. For this dive use: ${allowed.join(", ")}.`);
          if (!skills.length && s.status !== "Draft") problems.push(`Pick at least one skill (or "no skills"): ${allowed.join(", ")}.`);
        }
      }
      if (s.status !== "Draft" && !s.instructor_number) problems.push("Training dives need the instructor's PADI number (use logbook_submit_for_verification).");
    } else if (s.skills?.length) {
      problems.push("Skills are only for training dives.");
    }
    if (problems.length) fail(problems);
  }

  /** Canonical spellings of training skills ("Swim Compass" -> "swim compass"). */
  private normaliseSkills(skills: string[] | null | undefined, course: string | null, logNumber: number | null): string[] | null | undefined {
    if (!skills) return skills;
    if (course === "SpecialtyAndDistinctive" || !isEnumValue("course", course)) return skills.map((k) => k.trim()).filter(Boolean);
    const allowed = allowedSkills(course, logNumber);
    return [...new Set(skills.map((k) => allowed.find((a) => enumKey(a) === enumKey(k)) ?? k.trim()))];
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  async listDives(args: ListDivesArgs): Promise<ListDivesResult> {
    checkRange(args.from, args.to);
    const system = await this.resolveUnits();
    const limit = args.limit ?? 15;
    const offset = args.offset ?? 0;
    const local = !!(args.from || args.to || args.query || (args.log_type && args.status));
    let total: number;
    let dives: DiveSummary[];
    if (local) {
      const all = await this.backend.listLogs({
        limit: null,
        orderBy: args.sort ?? "date",
        withDepthTime: true,
        ...(args.query ? { full: true } : {}),
        ...(args.log_type ? { logType: args.log_type } : args.status ? { status: args.status } : {}),
      });
      const q = args.query ? enumKeyText(args.query) : "";
      const matching = all.filter((w) => {
        if (args.log_type && w.log_type !== args.log_type) return false;
        if (args.status && w.status !== args.status) return false;
        const summary = toDiveSummary(w, system);
        if (!inRange(summary.date, args.from, args.to)) return false;
        if (q) {
          const hay = enumKeyText([w.dive_title, w.dive_location, w.experiences?.[0]?.buddies].filter(Boolean).join(" "));
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      total = matching.length;
      dives = matching.slice(offset, offset + limit).map((w) => toDiveSummary(w, system));
    } else {
      const filter = args.log_type ? { logType: args.log_type } : args.status ? { status: args.status } : {};
      const [count, rows] = await Promise.all([
        this.backend.countLogs(filter),
        this.backend.listLogs({ limit, offset, orderBy: args.sort ?? "date", withDepthTime: true, ...filter }),
      ]);
      total = count;
      dives = rows.map((w) => toDiveSummary(w, system));
    }
    const result: ListDivesResult = { total, dives, units: unitLabels(system) };
    if (offset + dives.length < total && dives.length > 0) result.next_offset = offset + dives.length;
    return result;
  }

  async getDive(args: GetDiveArgs): Promise<Dive> {
    const system = await this.resolveUnits(args.units);
    return toDive(await this.existing(args.dive_id), system);
  }

  async stats(args: StatsArgs): Promise<StatsResult> {
    checkRange(args.from, args.to);
    const system = await this.resolveUnits(args.units);
    const all = await this.backend.listLogs({ limit: null, orderBy: "date", withDepthTime: true });
    const dives = all.map((w) => toDiveSummary(w, system)).filter((d) => inRange(d.date, args.from, args.to));
    const groupBy = args.group_by ?? "none";
    const result: StatsResult = { ...summarise(dives), units: unitLabels(system), group_by: groupBy };
    if (args.from) result.from = args.from;
    if (args.to) result.to = args.to;
    if (groupBy !== "none") result.groups = group(dives, groupBy);
    return result;
  }

  async searchSites(args: SearchSitesArgs): Promise<SearchSitesResult> {
    const query = args.query.trim();
    if (!query) throw new UserFacingError("Give part of a dive site name.");
    // Escape LIKE wildcards in the user's text, then look for it anywhere in the name.
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const sites = await this.backend.searchSites(pattern, args.limit ?? 20);
    return { sites, note: "These are PADI's site names. Any other text is also accepted as a dive location." };
  }

  async lookupInstructor(memberNumber: string): Promise<InstructorInfo> {
    const n = memberNumber.trim();
    if (!/^\d{1,12}$/.test(n)) throw new UserFacingError("A PADI member number has digits only.");
    const matches = await this.backend.lookupInstructor(n);
    const first = matches[0];
    return first ? { member_number: n, found: true, ...(first.name ? { name: first.name } : {}) } : { member_number: n, found: false };
  }

  async getUnits(): Promise<UnitsResult> {
    const padi = await this.padiUnits(true);
    const effective: UnitSystem = this.opts.units === "auto" ? (padi === "Imperial" ? "imperial" : "metric") : this.opts.units;
    return { padi_setting: padi, effective };
  }

  async listCertifications(): Promise<Certification[]> {
    return this.backend.listCertifications();
  }

  async getPhotos(args: GetPhotosArgs): Promise<GetPhotosResult> {
    const max = Math.min(Math.max(args.max ?? 3, 1), 5);
    await this.existing(args.dive_id);
    const ids = await this.backend.listPhotoIds(args.dive_id);
    const photos: DivePhoto[] = [];
    let skipped = Math.max(0, ids.length - max);
    let total = 0;
    let firstError: unknown;
    for (const id of ids.slice(0, max)) {
      try {
        const photo = await this.backend.getPhoto(args.dive_id, id);
        if (photo.data.length > MAX_PHOTO_BYTES || total + photo.data.length > MAX_PHOTOS_TOTAL_BYTES) {
          skipped++;
          continue;
        }
        total += photo.data.length;
        photos.push({ id, mimeType: photo.mimeType, data: photo.data });
      } catch (error) {
        firstError ??= error;
        skipped++;
      }
    }
    if (!photos.length && firstError) throw firstError;
    return { dive_id: args.dive_id, total: ids.length, photos, ...(skipped ? { skipped } : {}) };
  }

  async exportDives(args: ExportArgs): Promise<ExportResult> {
    checkRange(args.from, args.to);
    const system = await this.resolveUnits(args.units);
    const all = await this.backend.listLogs({ limit: null, orderBy: "date", full: true });
    const dives = all
      .map((w) => toDive(w, system))
      .filter((d) => inRange(d.date, args.from, args.to))
      .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
    const units = unitLabels(system);
    const content = args.format === "json" ? JSON.stringify(dives, null, 2) : toCsv(dives, units);
    return { format: args.format, count: dives.length, units, content };
  }

  async account(): Promise<PadiAccount> {
    return this.backend.account();
  }

  async check(): Promise<CheckResult> {
    return this.backend.check();
  }

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  async createDive(args: CreateDiveArgs): Promise<Dive> {
    this.assertWritable("logbook_create_dive");
    return this.serial(async () => {
      const system = await this.resolveUnits(args.units);
      const { units: _units, training, status, ...fields } = args;
      void _units;
      let s = applyPatch(emptyState(), this.metricPatch(fields as DivePatch, system));
      s.status = status ?? "Publish";
      if (training) {
        const course = training.course;
        if (!isEnumValue("course", course)) fail([`Unknown course "${String(course)}". Use one of: ${describeEnum("course")}`]);
        const logNumber = course === "SpecialtyAndDistinctive" ? null : (training.log_number ?? null);
        const catalogue = logNumber !== null ? trainingDive(course, logNumber) : undefined;
        const adventure = training.adventure_dive ? this.metricPatch({ adventure_dive: training.adventure_dive }, system).adventure_dive : undefined;
        s = {
          ...s,
          log_type: "Training",
          course,
          log_number: logNumber,
          // Training dives are saved as Draft; logbook_submit_for_verification sends them.
          status: "Draft",
          title: catalogue?.title ?? s.title,
          adventure_dive: adventure ?? null,
          skills: this.normaliseSkills(training.skills, course, logNumber) ?? null,
        };
      }
      this.validate(s, { checkDate: true, system });
      if (training && s.log_number !== null && s.course !== "Reactivate") {
        const all = await this.backend.listLogs({ limit: null, logType: "Training" });
        const same = all.find((w) => w.log_course === s.course && Number(w.log_number) === s.log_number);
        if (same) throw new UserFacingError(`"${s.title}" is already in your logbook (dive ${same.id}). Change that dive instead.`);
      }
      const payload = buildInsert(s, this.now());
      const id = await this.backend.insertLog(payload);
      const created = await this.backend.getLog(id);
      return toDive(created ?? wireFromInsert(id, payload), system);
    });
  }

  async updateDive(args: UpdateDiveArgs): Promise<Dive> {
    this.assertWritable("logbook_update_dive");
    return this.serial(async () => {
      const system = await this.resolveUnits(args.units);
      const { dive_id: id, units: _units, ...raw } = args;
      void _units;
      const patch = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as DivePatch;
      if (!Object.keys(patch).length) throw new UserFacingError("Nothing to change: give at least one field.");
      const existing = await this.existing(id);
      if (isLocked(existing.status)) throw new UserFacingError(describeLocked(existing, "changed"));
      const before = stateFromWire(existing);
      const metric = this.metricPatch(patch, system);
      if (metric.skills !== undefined) metric.skills = this.normaliseSkills(metric.skills, before.course, before.log_number) ?? null;
      if (before.log_type === "Training" && metric.status === "Publish") {
        throw new UserFacingError("Training dives stay Draft until they are sent to a PADI Pro with logbook_submit_for_verification.");
      }
      if (before.log_type !== "Training" && metric.skills?.length) throw new UserFacingError("Skills are only for training dives.");
      const s = applyPatch(before, metric);
      this.validate(s, { checkDate: patch.date !== undefined, system });
      const update = buildUpdate(existing, s, this.now(), {
        withTimes: patch.time_in !== undefined || patch.time_out !== undefined,
        withSkills: patch.skills !== undefined,
      });
      await this.backend.updateLog(update);
      const after = await this.backend.getLog(id);
      return toDive(after ?? existing, system);
    });
  }

  async deleteDive(args: DeleteDiveArgs): Promise<DeleteDiveResult> {
    this.assertWritable("logbook_delete_dive");
    return this.serial(async () => {
      const system = await this.resolveUnits();
      const existing = await this.existing(args.dive_id);
      if (isLocked(existing.status)) throw new UserFacingError(describeLocked(existing, "deleted"));
      // A dive without a title is confirmed with its id.
      const title = (existing.dive_title ?? "").trim() || String(args.dive_id);
      const confirm = args.confirm_title.trim();
      if (confirm.toLowerCase() !== title.toLowerCase()) {
        throw new UserFacingError(`confirm_title does not match. To delete dive ${args.dive_id}, give its title exactly: "${title}".`);
      }
      const dive = toDive(existing, system);
      await this.backend.deleteLog(args.dive_id);
      return { deleted: true, dive };
    });
  }

  async submitForVerification(args: SubmitForVerificationArgs): Promise<SubmitForVerificationResult> {
    this.assertWritable("logbook_submit_for_verification");
    if (args.confirm !== true) throw new UserFacingError("Set confirm to true once the user agreed to send the dive to the PADI Pro.");
    return this.serial(async () => {
      const system = await this.resolveUnits();
      const number = args.instructor_number.trim();
      if (!/^\d{1,12}$/.test(number)) throw new UserFacingError("A PADI member number has digits only.");
      const existing = await this.existing(args.dive_id);
      if (isLocked(existing.status)) throw new UserFacingError(describeLocked(existing, "sent for verification"));
      // Look the PADI Pro up first: an unknown number is refused before anything changes.
      const matches = await this.backend.lookupInstructor(number);
      const pro = matches[0];
      if (!pro) throw new UserFacingError(`No PADI Pro with member number ${number} was found. Check the number with your instructor.`);
      const s: DiveState = { ...stateFromWire(existing), status: "Pending", instructor_number: number };
      this.validate(s, { checkDate: false, system });
      await this.backend.updateLog(buildUpdate(existing, s, this.now()));
      const after = await this.backend.getLog(args.dive_id);
      return {
        dive: toDive(after ?? { ...existing, status: "Pending", memsys_member_number: Number(number) }, system),
        instructor: { member_number: number, found: true, ...(pro.name ? { name: pro.name } : {}) },
      };
    });
  }

  async setUnits(units: UnitSystem): Promise<UnitsResult> {
    this.assertWritable("logbook_set_units");
    return this.serial(async () => {
      const padi: Units = units === "imperial" ? "Imperial" : "Metric";
      await this.backend.setUnits(padi);
      this.unitsCache = { value: padi, at: this.now().getTime() };
      const effective: UnitSystem = this.opts.units === "auto" ? units : this.opts.units;
      return { padi_setting: padi, effective };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Statistics, export and other helpers
// ---------------------------------------------------------------------------------------------

/** Text for "contains" matching: lowercase, accents and separators kept simple. */
function enumKeyText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function ref(d: DiveSummary): DiveRef {
  return { dive_id: d.id, title: d.title, date: d.date, location: d.location };
}

/** The statistics of a list of dives (numbers in the units of the summaries). */
export function summarise(dives: DiveSummary[]): StatsSummary {
  const times = dives.filter((d) => d.bottom_time_min !== undefined);
  const depths = dives.filter((d) => d.max_depth !== undefined);
  const total = times.reduce((sum, d) => sum + d.bottom_time_min!, 0);
  const out: StatsSummary = { count: dives.length, total_bottom_time_min: total, total_bottom_time: formatMinutes(total) };
  if (depths.length) {
    const deepest = depths.reduce((a, b) => (b.max_depth! > a.max_depth! ? b : a));
    out.deepest = { ...ref(deepest), max_depth: deepest.max_depth! };
    out.average_max_depth = round(depths.reduce((sum, d) => sum + d.max_depth!, 0) / depths.length, 1);
  }
  if (times.length) {
    const longest = times.reduce((a, b) => (b.bottom_time_min! > a.bottom_time_min! ? b : a));
    out.longest = { ...ref(longest), bottom_time_min: longest.bottom_time_min! };
    out.average_bottom_time_min = round(total / times.length, 1);
  }
  const dates = dives.map((d) => d.date).filter(Boolean).sort();
  if (dates.length) {
    out.first_dive = dates[0]!;
    out.last_dive = dates[dates.length - 1]!;
  }
  return out;
}

function groupKey(d: DiveSummary, by: StatsGroupBy): string {
  switch (by) {
    case "year":
      return d.date ? d.date.slice(0, 4) : "unknown";
    case "month":
      return d.date ? d.date.slice(0, 7) : "unknown";
    case "location":
      return d.location || "unknown";
    case "dive_type":
      return d.dive_type ?? "unknown";
    case "log_type":
      return d.type;
    default:
      return "all";
  }
}

function group(dives: DiveSummary[], by: StatsGroupBy): Array<StatsSummary & { key: string }> {
  const groups = new Map<string, { key: string; dives: DiveSummary[] }>();
  for (const d of dives) {
    const key = groupKey(d, by);
    // Locations are grouped without regard to case and spacing; the first spelling is shown.
    const id = by === "location" ? enumKeyText(key) : key;
    const g = groups.get(id) ?? { key, dives: [] };
    g.dives.push(d);
    groups.set(id, g);
  }
  const out = [...groups.values()].map((g) => ({ key: g.key, ...summarise(g.dives) }));
  if (by === "year" || by === "month") out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return out;
}

/** CSV columns: [header, value]. Unit-bearing headers carry the unit. */
function csvColumns(u: DiveUnits): Array<[string, (d: Dive) => unknown]> {
  return [
    ["id", (d) => d.id],
    ["date", (d) => d.date],
    ["title", (d) => d.title],
    ["location", (d) => d.location],
    ["log_type", (d) => d.type],
    ["status", (d) => d.status],
    ["dive_type", (d) => d.dive_type],
    ["course", (d) => d.course],
    ["log_number", (d) => d.log_number],
    [`max_depth_${u.depth}`, (d) => d.max_depth],
    ["bottom_time_min", (d) => d.bottom_time_min],
    ["time_in", (d) => d.time_in],
    ["time_out", (d) => d.time_out],
    ["water_type", (d) => d.water_type],
    ["body_of_water", (d) => d.body_of_water],
    ["weather", (d) => d.weather],
    [`air_temp_${u.temp}`, (d) => d.air_temp],
    [`surface_water_temp_${u.temp}`, (d) => d.surface_water_temp],
    [`bottom_water_temp_${u.temp}`, (d) => d.bottom_water_temp],
    ["visibility", (d) => d.visibility],
    [`visibility_distance_${u.depth}`, (d) => d.visibility_distance],
    ["waves", (d) => d.waves],
    ["current", (d) => d.current],
    ["surge", (d) => d.surge],
    ["suit", (d) => d.suit],
    [`weight_${u.weight}`, (d) => d.weight],
    ["weight_type", (d) => d.weight_type],
    ["equipment", (d) => d.equipment],
    ["cylinder_type", (d) => d.cylinder_type],
    [`cylinder_size_${u.volume}`, (d) => d.cylinder_size],
    ["gas", (d) => d.gas],
    ["oxygen_pct", (d) => d.oxygen_pct],
    ["nitrogen_pct", (d) => d.nitrogen_pct],
    ["helium_pct", (d) => d.helium_pct],
    [`start_pressure_${u.pressure}`, (d) => d.start_pressure],
    [`end_pressure_${u.pressure}`, (d) => d.end_pressure],
    [`pressure_used_${u.pressure}`, (d) => d.pressure_used],
    ["feeling", (d) => d.feeling],
    ["notes", (d) => d.notes],
    ["buddies", (d) => d.buddies],
    ["dive_center", (d) => d.dive_center],
    ["instructor_number", (d) => d.instructor_number],
    ["adventure_dive", (d) => d.adventure_dive],
    ["skills", (d) => d.skills],
    ["locked", (d) => d.locked],
    ["web_url", (d) => d.web_url],
  ];
}

/** Dives as CSV (RFC 4180, CRLF line ends, a header row). */
export function toCsv(dives: Dive[], units: DiveUnits): string {
  const columns = csvColumns(units);
  const lines = [columns.map(([h]) => csvCell(h)).join(",")];
  for (const d of dives) lines.push(columns.map(([, get]) => csvCell(get(d))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** A WireLog built from an insert payload (when PADI does not return the new dive at once). */
function wireFromInsert(id: number, p: WireLogInsert): WireLog {
  return {
    id,
    log_type: p.log_type,
    log_course: p.log_course,
    log_number: p.log_number,
    dive_title: p.dive_title,
    dive_date: p.dive_date,
    dive_location: p.dive_location,
    status: p.status,
    dive_type: p.dive_type,
    memsys_member_number: p.memsys_member_number,
    adventure_dive: p.adventure_dive ?? null,
    depth_times: [{ max_depth: p.depth_times.data.max_depth ?? null, bottom_time: p.depth_times.data.bottom_time ?? null }],
    conditions: [
      {
        water_type: p.conditions.data.water_type ?? null,
        body_of_water: p.conditions.data.body_of_water ?? null,
        weather: p.conditions.data.weather ?? null,
        air_temp: p.conditions.data.air_temp ?? null,
        surface_water_temp: p.conditions.data.surface_water_temp ?? null,
        bottom_water_temp: p.conditions.data.bottom_water_temp ?? null,
        visibility: p.conditions.data.visibility ?? null,
        visibility_distance: p.conditions.data.visibility_distance ?? null,
        wave_condition: p.conditions.data.wave_condition ?? null,
        current: p.conditions.data.current ?? null,
        surge: p.conditions.data.surge ?? null,
      },
    ],
    equipment: [
      {
        suit_type: p.equipment.data.suit_type ?? null,
        weight: p.equipment.data.weight ?? null,
        weight_type: p.equipment.data.weight_type ?? null,
        additional_equipment: p.equipment.data.additional_equipment ?? null,
        cylinder_type: p.equipment.data.cylinder_type ?? null,
        cylinder_size: p.equipment.data.cylinder_size ?? null,
        gas_mixture: p.equipment.data.gas_mixture ?? null,
        oxygen: p.equipment.data.oxygen ?? null,
        nitrogen: p.equipment.data.nitrogen ?? null,
        helium: p.equipment.data.helium ?? null,
        starting_pressure: p.equipment.data.starting_pressure ?? null,
        ending_pressure: p.equipment.data.ending_pressure ?? null,
      },
    ],
    experiences: [
      {
        feeling: p.experiences.data.feeling ?? null,
        notes: p.experiences.data.notes ?? null,
        buddies: p.experiences.data.buddies ?? null,
        dive_center: p.experiences.data.dive_center ?? null,
      },
    ],
    skills: p.skills ? [{ dive_skills: p.skills.data.dive_skills ?? null }] : [],
  };
}
