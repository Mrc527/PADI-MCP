/**
 * LogbookService: everything between the MCP tools and a LogbookBackend.
 *
 * It validates input (the zod shapes below are shared with the tools), converts units, merges an
 * update into the stored dive (read, merge, write), refuses locked dives (Pending, Verified,
 * QR Code Verified), checks confirmations, computes statistics and builds exports. The backend
 * only moves wire data. Writes of one service instance run one after another.
 */

import { z } from "zod";
import { NotFoundError, ReadOnlyError, UnconfirmedWriteError, UserFacingError } from "../util/errors.js";
import { parseDateOnly, todayInZone } from "../util/dates.js";
import {
  ADVENTURE_DIVES,
  ADVENTURE_ELECTIVE_NUMBERS,
  allowedSkills,
  canonicalEquipment,
  canonicalSkill,
  describeEnum,
  enumKey,
  FLEXIBLE_SKILLS,
  GAS_PRESETS,
  isEnumValue,
  LATER_SKILLS,
  parseAdventureDive,
  parseEnum,
  REACTIVATE_REQUIREMENTS,
  RESCUE_EXERCISES,
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
  diveWebUrl,
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
  /** IANA time zone of the server's "today" (for the 100-year check and for display). */
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
  units?: UnitChoice;
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
  /** The deleted dive, so it can be created again (as a new dive with a new id). */
  dive: Dive;
  /** False when PADI's photo service could not be asked whether the dive had photos. */
  photos_checked?: false;
  note?: string;
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
  /** Photos left out (too large, over `max`, not readable, or of a type AI apps do not show). */
  skipped?: number;
  /** Photos left out because AI apps cannot show their image type (see them at web_url). */
  skipped_unsupported?: Array<{ id: string; mimeType: string }>;
  /** Where the dive and its photos can be seen on learning.padi.com. */
  web_url?: string;
}

export interface ExportArgs {
  format: "csv" | "json";
  from?: string;
  to?: string;
  units?: UnitChoice;
  /** Dives in this part, 1-500 (default 50 for json, 100 for csv). */
  limit?: number;
  offset?: number;
}

export interface ExportResult {
  format: "csv" | "json";
  /** Dives in the date range. */
  total: number;
  /** Dives in this part. */
  count: number;
  offset: number;
  /** The offset of the next part, when there is one. */
  next_offset?: number;
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
/** Default and largest number of dives in one export answer (AI apps cap the size of a tool answer). */
export const EXPORT_DEFAULT_LIMIT = { json: 50, csv: 100 } as const;
export const EXPORT_MAX_LIMIT = 500;
/** Image types AI apps accept in a tool answer. */
export const SHOWABLE_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** How long deleteDive waits for PADI's photo list before it goes on without it. */
const PHOTO_CHECK_MS = 10_000;
/**
 * The latest calendar date anywhere on Earth is "today" in UTC+14 (Etc/GMT-14 is UTC+14 in the
 * IANA naming). Dates after it are in the future for every user, whatever their time zone.
 */
const EARLIEST_ZONE = "Etc/GMT-14";

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

const WRITABLE_STATUS_TEXT = "Publish (a logged dive, the default) or Draft (incomplete: depth and time may be missing)";
const TRAINING_SHAPE_TEXT = "Only for training dives (saved as Draft; then use logbook_submit_for_verification)";

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
  .describe(WRITABLE_STATUS_TEXT);

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
  units: unitChoice.optional(),
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
  limit: z
    .number()
    .int()
    .min(1)
    .max(EXPORT_MAX_LIMIT)
    .optional()
    .describe(`Dives in this part, 1-${EXPORT_MAX_LIMIT} (default ${EXPORT_DEFAULT_LIMIT.json} for json, ${EXPORT_DEFAULT_LIMIT.csv} for csv). Large logbooks come in parts`),
  offset: z.number().int().min(0).optional().describe("Dives to skip, oldest first (use next_offset of the previous part)"),
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

const quoted = (items: readonly string[]) => items.map((k) => `"${k}"`).join(", ");

/** The skills of each course, as the PADI web form offers them. */
export const SKILLS_TEXT =
  `Open (flexible skills): ${quoted(FLEXIBLE_SKILLS)}, and for dives 2-4 also ${quoted(LATER_SKILLS)} ("no skills" when none was done). ` +
  `Rescue (exercises): ${quoted(RESCUE_EXERCISES)}. ` +
  `Reactivate (requirements): ${quoted(REACTIVATE_REQUIREMENTS)} ("panicked diver" is PADI's value of the "buoyancy / weight check" item). ` +
  "Specialty: one free-text entry (the specialty). Advanced and DSD dives store no skills. Open, Rescue and Reactivate dives need at least one before verification";

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
    adventure_dive: z.string().trim().min(1).max(80).nullable().optional().describe(`Advanced elective dives 7-9 only: ${ADVENTURE_DIVES.join(", ")}`),
    skills: skillList.nullable().optional().describe(`Skills done, PADI's values for the course. ${SKILLS_TEXT}`),
  })
  .describe(TRAINING_SHAPE_TEXT);

export const createDiveShape = {
  title: z.string().trim().min(1).max(200).describe(D.title),
  date: dateOnly.describe(D.date),
  location: z.string().trim().min(1).max(200).describe(D.location),
  dive_type: enumInput("dive_type", "dive type").pipe(z.custom<EnumValue<"dive_type">>((v) => v !== undefined, "Give a dive type")).describe(D.dive_type),
  status: writableStatus.nullable().optional().describe(WRITABLE_STATUS_TEXT),
  max_depth: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.max_depth),
  bottom_time_min: z.number().int().min(0).max(PADI_MAX_NUMBER).nullable().optional().describe(D.bottom_time_min),
  time_in: timeOfDay.nullable().optional().describe(D.time_in),
  time_out: timeOfDay.nullable().optional().describe(D.time_out),
  water_type: enumInput("water_type", "water type").nullable().optional().describe(D.water_type),
  body_of_water: enumInput("body_of_water", "body of water").nullable().optional().describe(D.body_of_water),
  weather: enumInput("weather", "weather").nullable().optional().describe(D.weather),
  air_temp: num(-100, 200).nullable().optional().describe(D.air_temp),
  surface_water_temp: num(-100, 200).nullable().optional().describe(D.surface_water_temp),
  bottom_water_temp: num(-100, 200).nullable().optional().describe(D.bottom_water_temp),
  visibility: enumInput("visibility", "visibility").nullable().optional().describe(D.visibility),
  visibility_distance: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.visibility_distance),
  waves: enumInput("waves", "waves").nullable().optional().describe(D.waves),
  current: enumInput("current", "current").nullable().optional().describe(D.current),
  surge: enumInput("surge", "surge").nullable().optional().describe(D.surge),
  suit: enumInput("suit", "suit").nullable().optional().describe(D.suit),
  weight: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.weight),
  weight_type: enumInput("weight_type", "weighting").nullable().optional().describe(D.weight_type),
  equipment: equipmentList.nullable().optional().describe(D.equipment),
  cylinder_type: enumInput("cylinder_type", "cylinder type").nullable().optional().describe(D.cylinder_type),
  cylinder_size: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.cylinder_size),
  gas: enumInput("gas", "gas").nullable().optional().describe(D.gas),
  oxygen_pct: z.number().int().min(0).max(100).nullable().optional().describe(D.oxygen_pct),
  nitrogen_pct: z.number().int().min(0).max(100).nullable().optional().describe(D.nitrogen_pct),
  helium_pct: z.number().int().min(0).max(100).nullable().optional().describe(D.helium_pct),
  start_pressure: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.start_pressure),
  end_pressure: num(0, PADI_MAX_NUMBER).nullable().optional().describe(D.end_pressure),
  feeling: enumInput("feeling", "feeling").nullable().optional().describe(D.feeling),
  notes: text(10_000).nullable().optional().describe(D.notes),
  buddies: text(500).nullable().optional().describe(D.buddies),
  dive_center: text(200).nullable().optional().describe(D.dive_center),
  training: trainingShape.nullable().optional().describe(TRAINING_SHAPE_TEXT),
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
  skills: skillList.nullable().optional().describe(`Training dives only: the skills done (replaces the list)${CLEAR}. ${SKILLS_TEXT}`),
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

/** A copy without the keys whose value is null (on create, null means "not given"). */
function withoutNulls<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as T;
}

/** True when a change gives a unit-bearing number (its units must then be known). */
function hasUnitNumbers(patch: DivePatch): boolean {
  return UNIT_FIELDS.some(([field]) => typeof patch[field] === "number");
}

/**
 * A write whose answer did not come back may have been saved: replace the generic message with
 * one that names the dive and says how to check before sending it again.
 */
async function explainUnconfirmed<T>(write: Promise<T>, message: string): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof UnconfirmedWriteError) throw new UnconfirmedWriteError(message, { cause: error });
    throw error;
  }
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

  /**
   * The PADI units setting, cached for UNITS_CACHE_MS. When PADI cannot be asked, the last known
   * value is used even when it is older (not for `fresh`, which must ask PADI).
   */
  private async padiUnits(fresh = false): Promise<Units> {
    const at = this.now().getTime();
    const cached = this.unitsCache;
    if (!fresh && cached && at - cached.at < UNITS_CACHE_MS) return cached.value;
    try {
      const value = await this.backend.getUnits();
      this.unitsCache = { value, at };
      return value;
    } catch (error) {
      if (!fresh && cached) return cached.value;
      throw error;
    }
  }

  /**
   * The unit system of a call: its own choice, else the account setting ("auto": PADI's). When
   * the PADI setting cannot be read, answers are in metric (what PADI stores; every answer names
   * its units). Numbers given in a call (`forInput`) are never guessed: the call must then name
   * its units, or a 60 meant as ft could be saved as 60 m.
   */
  async resolveUnits(choice?: UnitChoice, opts: { forInput?: boolean } = {}): Promise<UnitSystem> {
    const c = choice ?? this.opts.units;
    if (c === "metric" || c === "imperial") return c;
    try {
      return (await this.padiUnits()) === "Imperial" ? "imperial" : "metric";
    } catch (error) {
      if (opts.forInput) {
        throw new UserFacingError('Could not read your PADI units setting, so the numbers of this call could be metric or imperial. Nothing was saved. Repeat the call with units "metric" or "imperial".', { cause: error });
      }
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

  /**
   * The rules of the PADI web form, on a merged state. Throws one error listing every problem.
   * `checkSkills`: also refuse skills the PADI form does not offer for the course (on create, and
   * when a change sets the skills; dives PADI already holds can be changed and sent as they are).
   */
  private validate(s: DiveState, opts: { checkDate: boolean; checkSkills: boolean; system: UnitSystem }): void {
    const problems: string[] = [];
    if (!s.title.trim()) problems.push("A title is needed.");
    if (!s.location.trim()) problems.push("A location is needed.");
    if (!s.dive_type) problems.push(`A dive type is needed: ${describeEnum("dive_type")}.`);
    if (!opts.checkDate && !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
      // A dive saved by another app without a usable date: PADI needs one on every write.
      problems.push("This dive has no date. Give date (YYYY-MM-DD).");
    }
    if (opts.checkDate) {
      try {
        parseDateOnly(s.date);
        // The user's own date can be ahead of the server's: a date is only "in the future" when it
        // is after today everywhere on Earth.
        if (s.date > todayInZone(EARLIEST_ZONE, this.now())) problems.push(`The date ${s.date} is in the future.`);
        else if (s.date < yearsBefore(this.today(), 100)) problems.push(`The date ${s.date} is more than 100 years ago.`);
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
          const unknown = opts.checkSkills ? skills.filter((k) => !allowed.includes(k)) : [];
          if (unknown.length) problems.push(`Unknown skill${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `"${u}"`).join(", ")}. For this ${course} dive use: ${allowed.join(", ")}.`);
          if (!skills.length && s.status !== "Draft") {
            problems.push(`Pick at least one skill${course === "Open" ? ' (or "no skills")' : ""}: ${allowed.join(", ")}.`);
          }
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
    return [...new Set(skills.map((k) => canonicalSkill(course, logNumber, k) ?? k.trim()))];
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  async listDives(args: ListDivesArgs): Promise<ListDivesResult> {
    checkRange(args.from, args.to);
    const system = await this.resolveUnits(args.units);
    const limit = args.limit ?? 15;
    const offset = args.offset ?? 0;
    const sort = args.sort ?? "date";
    // Depth and time are sorted here: PADI's descending order puts dives without a value first,
    // and has no tie-breaker for paging.
    const byValue = sort === "max_depth" || sort === "bottom_time";
    const local = byValue || !!(args.from || args.to || args.query || (args.log_type && args.status));
    let total: number;
    let dives: DiveSummary[];
    if (local) {
      const all = await this.backend.listLogs({
        limit: null,
        orderBy: "date",
        withDepthTime: true,
        ...(args.query ? { full: true } : {}),
        ...(args.log_type ? { logType: args.log_type } : args.status ? { status: args.status } : {}),
      });
      const q = args.query ? enumKeyText(args.query) : "";
      const matching: DiveSummary[] = [];
      for (const w of all) {
        if (args.log_type && w.log_type !== args.log_type) continue;
        if (args.status && w.status !== args.status) continue;
        const summary = toDiveSummary(w, system);
        if (!inRange(summary.date, args.from, args.to)) continue;
        if (q) {
          const hay = enumKeyText([w.dive_title, w.dive_location, w.experiences?.[0]?.buddies].filter(Boolean).join(" "));
          if (!hay.includes(q)) continue;
        }
        matching.push(summary);
      }
      if (byValue) matching.sort(byValueDesc(sort === "max_depth" ? "max_depth" : "bottom_time_min"));
      total = matching.length;
      dives = matching.slice(offset, offset + limit);
    } else {
      const filter = args.log_type ? { logType: args.log_type } : args.status ? { status: args.status } : {};
      const [count, rows] = await Promise.all([
        this.backend.countLogs(filter),
        this.backend.listLogs({ limit, offset, orderBy: "date", withDepthTime: true, ...filter }),
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
    const existing = await this.existing(args.dive_id);
    const ids = await this.backend.listPhotoIds(args.dive_id);
    const photos: DivePhoto[] = [];
    const unsupported: Array<{ id: string; mimeType: string }> = [];
    let skipped = Math.max(0, ids.length - max);
    let total = 0;
    let firstError: unknown;
    for (const id of ids.slice(0, max)) {
      try {
        const photo = await this.backend.getPhoto(args.dive_id, id);
        const mimeType = photo.mimeType.split(";")[0]!.trim().toLowerCase();
        // AI apps refuse a whole answer with an image of another type (HEIC, TIFF, not an image).
        if (!SHOWABLE_IMAGE_TYPES.includes(mimeType)) {
          unsupported.push({ id, mimeType: photo.mimeType });
          skipped++;
          continue;
        }
        if (photo.data.length > MAX_PHOTO_BYTES || total + photo.data.length > MAX_PHOTOS_TOTAL_BYTES) {
          skipped++;
          continue;
        }
        total += photo.data.length;
        photos.push({ id, mimeType, data: photo.data });
      } catch (error) {
        firstError ??= error;
        skipped++;
      }
    }
    if (!photos.length && !unsupported.length && firstError) throw firstError;
    return {
      dive_id: args.dive_id,
      total: ids.length,
      photos,
      ...(skipped ? { skipped } : {}),
      ...(unsupported.length ? { skipped_unsupported: unsupported } : {}),
      ...(skipped ? { web_url: diveWebUrl(existing.id, existing.log_type) } : {}),
    };
  }

  async exportDives(args: ExportArgs): Promise<ExportResult> {
    checkRange(args.from, args.to);
    const system = await this.resolveUnits(args.units);
    // One query for every dive (as designed); the answer comes in parts that fit AI apps.
    const all = await this.backend.listLogs({ limit: null, orderBy: "date", full: true });
    const dives = all
      .map((w) => toDive(w, system))
      .filter((d) => inRange(d.date, args.from, args.to))
      .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
    const limit = Math.min(Math.max(args.limit ?? EXPORT_DEFAULT_LIMIT[args.format], 1), EXPORT_MAX_LIMIT);
    const offset = Math.max(args.offset ?? 0, 0);
    const part = dives.slice(offset, offset + limit);
    const units = unitLabels(system);
    // JSON: one compact dive per line, without the units of each dive (they are in the summary).
    const content =
      args.format === "json"
        ? `[${part
            .map(({ units: _units, ...d }) => {
              void _units;
              return `\n${JSON.stringify(d)}`;
            })
            .join(",")}${part.length ? "\n" : ""}]`
        : toCsv(part, units);
    const result: ExportResult = { format: args.format, total: dives.length, count: part.length, offset, units, content };
    if (offset + part.length < dives.length) result.next_offset = offset + part.length;
    return result;
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

  /**
   * The dive as PADI has it after a write. The write is done by then, so a failed read never
   * throws (the caller could send the write again and, for a new dive, log it twice): the answer
   * is then built from what was sent, with a note.
   */
  private async readBack(id: number, fallback: () => WireLog, system: UnitSystem): Promise<Dive> {
    let wire: WireLog | undefined;
    let failed = false;
    try {
      wire = await this.backend.getLog(id);
    } catch {
      failed = true;
    }
    const dive = toDive(wire ?? fallback(), system);
    if (failed) dive.note = `Saved, but PADI did not return the saved dive, so this is what was sent. Check it with logbook_get_dive (dive_id ${id}); do not send the change again.`;
    return dive;
  }

  /** How many photos PADI has for a dive, or undefined when the photo service does not answer. */
  private async photoCount(id: number): Promise<number | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PHOTO_CHECK_MS);
      timer.unref?.();
    });
    try {
      const ids = await Promise.race([this.backend.listPhotoIds(id), timeout]);
      return ids?.length;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async createDive(args: CreateDiveArgs): Promise<Dive> {
    this.assertWritable("logbook_create_dive");
    return this.serial(async () => {
      // On create, null means "not given" (some AI apps send null for every field they leave out).
      const { units, training: rawTraining, status, ...fields } = withoutNulls(args) as CreateDiveArgs;
      const training = rawTraining ? (withoutNulls(rawTraining) as NonNullable<CreateDiveArgs["training"]>) : undefined;
      const system = await this.resolveUnits(units, { forInput: hasUnitNumbers(fields as DivePatch) });
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
      this.validate(s, { checkDate: true, checkSkills: true, system });
      if (training && s.log_number !== null && s.course !== "Reactivate") {
        const all = await this.backend.listLogs({ limit: null, logType: "Training" });
        const same = all.find((w) => w.log_course === s.course && Number(w.log_number) === s.log_number);
        if (same) throw new UserFacingError(`"${s.title}" is already in your logbook (dive ${same.id}). Change that dive instead.`);
      }
      const payload = buildInsert(s, this.now());
      const id = await explainUnconfirmed(
        this.backend.insertLog(payload),
        `PADI did not confirm that the dive "${s.title}" on ${s.date} was saved, so it may have been saved anyway. ` +
          `Check with logbook_list_dives (from ${s.date}, to ${s.date}) before you try again, so the dive is not logged twice.`,
      );
      return this.readBack(id, () => wireFromInsert(id, payload), system);
    });
  }

  async updateDive(args: UpdateDiveArgs): Promise<Dive> {
    this.assertWritable("logbook_update_dive");
    return this.serial(async () => {
      const { dive_id: id, units, ...raw } = args;
      const patch = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as DivePatch;
      if (!Object.keys(patch).length) throw new UserFacingError("Nothing to change: give at least one field.");
      const system = await this.resolveUnits(units, { forInput: hasUnitNumbers(patch) });
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
      this.validate(s, { checkDate: patch.date !== undefined, checkSkills: patch.skills !== undefined, system });
      const now = this.now();
      const update = buildUpdate(existing, s, now, {
        withTimes: patch.time_in !== undefined || patch.time_out !== undefined,
        withSkills: patch.skills !== undefined,
      });
      await explainUnconfirmed(
        this.backend.updateLog(update),
        `PADI did not confirm the change of dive ${id}, so it may have been saved anyway. Check it with logbook_get_dive; sending the same change again is safe.`,
      );
      return this.readBack(
        id,
        () => {
          try {
            return { ...wireFromInsert(id, buildInsert(s, now)), log_type: existing.log_type };
          } catch {
            return existing;
          }
        },
        system,
      );
    });
  }

  async deleteDive(args: DeleteDiveArgs): Promise<DeleteDiveResult> {
    this.assertWritable("logbook_delete_dive");
    return this.serial(async () => {
      const id = args.dive_id;
      const system = await this.resolveUnits();
      const existing = await this.existing(id);
      if (isLocked(existing.status)) throw new UserFacingError(describeLocked(existing, "deleted"));
      // A dive without a title is confirmed with its id.
      const title = (existing.dive_title ?? "").trim() || String(id);
      const confirm = args.confirm_title.trim();
      if (confirm.toLowerCase() !== title.toLowerCase()) {
        // The stored title is not shown: it must come from the user, not from this error.
        throw new UserFacingError(
          `Dive ${id} is not titled "${confirm}". Nothing was deleted. Check which dive the user means (logbook_get_dive, or logbook_list_dives with query) and ask the user before you try again.`,
        );
      }
      const dive = toDive(existing, system);
      // The PADI web app deletes a dive's photos first. This server cannot delete photos, and
      // photos of a deleted dive cannot be seen or deleted any more: such a dive is deleted there.
      const photos = await this.photoCount(id);
      if (photos) {
        throw new UserFacingError(
          `Dive ${id} has ${photos} photo${photos === 1 ? "" : "s"}. This server cannot delete photos, and they would stay on PADI without a dive. Nothing was deleted. ` +
            `Delete the dive on learning.padi.com instead (${dive.web_url}), which deletes its photos too.`,
        );
      }
      await explainUnconfirmed(this.backend.deleteLog(id), `PADI did not confirm that dive ${id} was deleted. Check with logbook_get_dive before you try again.`);
      const result: DeleteDiveResult = { deleted: true, dive };
      if (photos === undefined) {
        result.photos_checked = false;
        result.note = "PADI's photo service did not answer, so it is not known whether the dive had photos. Photos are not part of the returned dive and cannot be restored.";
      }
      return result;
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
      this.validate(s, { checkDate: false, checkSkills: false, system });
      await explainUnconfirmed(
        this.backend.updateLog(buildUpdate(existing, s, this.now())),
        `PADI did not confirm that dive ${args.dive_id} was sent to the PADI Pro. Check it with logbook_get_dive (status Pending means it was sent) before you try again.`,
      );
      return {
        dive: await this.readBack(args.dive_id, () => ({ ...existing, status: "Pending", memsys_member_number: Number(number) }), system),
        instructor: { member_number: number, found: true, ...(pro.name ? { name: pro.name } : {}) },
      };
    });
  }

  async setUnits(units: UnitSystem): Promise<UnitsResult> {
    this.assertWritable("logbook_set_units");
    return this.serial(async () => {
      const padi: Units = units === "imperial" ? "Imperial" : "Metric";
      await explainUnconfirmed(this.backend.setUnits(padi), "PADI did not confirm the new units setting. Sending it again is safe.");
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

/**
 * Order of sort=max_depth / bottom_time: the largest value first, dives without a value last,
 * then the newest date and the highest id (a stable order for paging).
 */
function byValueDesc(key: "max_depth" | "bottom_time_min"): (a: DiveSummary, b: DiveSummary) => number {
  return (a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined) {
      if (x !== y) return x === undefined ? 1 : -1;
    } else if (x !== y) {
      return y - x;
    }
    return (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) || b.id - a.id;
  };
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
