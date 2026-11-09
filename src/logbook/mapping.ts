/**
 * Wire <-> domain mapping of the PADI logbook.
 *
 * - Reading: a WireLog (GraphQL shape, metric, numbers maybe as strings) becomes a DiveSummary or
 *   a Dive in the caller's units.
 * - Writing: the service works on a DiveState (one flat record of every field, metric, null for
 *   "no value"). A new dive's state becomes a WireLogInsert; an existing dive's state, merged
 *   with a change, becomes a WireLogUpdate that rewrites whole child rows.
 * - Postgres text[] columns (additional_equipment, dive_skills) are written as array literal
 *   strings ("{Hood,Gloves}") and read as JSON arrays.
 * - dive_date is written "MM/DD/YYYY" and read "YYYY-MM-DDTHH:MM:SS" (date part only).
 *   created_date and update_date are UTC wall clock "YYYY-MM-DDTHH:mm:ss" without "Z".
 */

import { GAS_PRESETS, isEnumValue, isLockedStatus } from "./enums.js";
import type {
  ChildTable,
  Dive,
  DivePatch,
  DiveStatus,
  DiveSummary,
  DiveType,
  LogType,
  TrainingCourse,
  UnitSystem,
  WireConditionsSet,
  WireDepthTimeSet,
  WireEquipmentSet,
  WireExperienceSet,
  WireLog,
  WireLogInsert,
  WireLogSet,
  WireLogSummary,
  WireLogUpdate,
  WireSkillsSet,
} from "./types.js";
import { fromMetric, unitLabels, type Quantity } from "./units.js";

// ---------------------------------------------------------------------------------------------
// Postgres array literals
// ---------------------------------------------------------------------------------------------

/** Items that must be quoted: empty, NULL, or with a separator, brace, quote, backslash or space. */
function needsQuotes(item: string): boolean {
  return item === "" || /^null$/i.test(item) || /[{},"\\\s]/.test(item);
}

/**
 * A Postgres array literal for a text[] column: ["Hood", "Gloves"] -> "{Hood,Gloves}",
 * ["no skills"] -> "{\"no skills\"}". null or undefined -> null; [] -> "{}".
 */
export function encodePgArray(items: readonly string[] | null | undefined): string | null {
  if (items === null || items === undefined) return null;
  const parts = items.map((item) => (needsQuotes(item) ? `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : item));
  return `{${parts.join(",")}}`;
}

/**
 * The items of a text[] value as read: a JSON array (what Hasura returns) or an array literal
 * string. Unquoted NULL items are dropped.
 */
export function decodePgArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
  if (typeof value !== "string") return [];
  const s = value.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return s ? [s] : [];
  const body = s.slice(1, -1);
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    if (body[i] === '"') {
      i++;
      let item = "";
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\" && i + 1 < body.length) i++;
        item += body[i];
        i++;
      }
      i++; // closing quote
      out.push(item);
      while (i < body.length && body[i] !== ",") i++;
    } else {
      let item = "";
      while (i < body.length && body[i] !== ",") {
        if (body[i] === "\\" && i + 1 < body.length) i++;
        item += body[i];
        i++;
      }
      const trimmed = item.trim();
      if (!/^null$/i.test(trimmed)) out.push(trimmed);
    }
    i++; // comma
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dates and numbers
// ---------------------------------------------------------------------------------------------

/** "YYYY-MM-DD" -> "MM/DD/YYYY" (the format PADI writes). */
export function toWireDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** The calendar date of a dive_date as read ("YYYY-MM-DDTHH:MM:SS"): "YYYY-MM-DD", or "". */
export function fromWireDate(value: string | null | undefined): string {
  if (!value) return "";
  const v = value.trim();
  const iso = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/);
  if (iso) return iso[1]!;
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  return "";
}

/** UTC wall clock without a zone, as PADI stores created_date and update_date. */
export function utcTimestamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19);
}

/** A number as read (JSON number or numeric string), or null. */
export function wireNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function wireText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.trim() === "" ? null : s;
}

// ---------------------------------------------------------------------------------------------
// Links and status
// ---------------------------------------------------------------------------------------------

export const WEB_BASE = "https://learning.padi.com/logbook/log-dive";

/** Where to see or edit a dive on learning.padi.com. */
export function diveWebUrl(id: number, logType: LogType | string | null | undefined): string {
  return `${WEB_BASE}/${logType === "Training" ? "training" : "recreational"}/update/${id}`;
}

/** Pending, Verified and QR Code Verified dives are locked. */
export function isLocked(status: string | null | undefined): boolean {
  return isLockedStatus(status);
}

// ---------------------------------------------------------------------------------------------
// DiveState: one flat, metric record of a dive
// ---------------------------------------------------------------------------------------------

/** Every field of a dive, metric, null for "no value". Enum fields hold PADI values. */
export interface DiveState {
  log_type: LogType;
  course: TrainingCourse | string | null;
  log_number: number | null;
  title: string;
  /** YYYY-MM-DD. */
  date: string;
  location: string;
  dive_type: DiveType | string | null;
  status: DiveStatus | string;
  /** memsys_member_number: the PADI Pro the dive was sent to. */
  instructor_number: string | null;
  adventure_dive: string | null;
  max_depth: number | null;
  bottom_time_min: number | null;
  time_in: string | null;
  time_out: string | null;
  water_type: string | null;
  body_of_water: string | null;
  weather: string | null;
  air_temp: number | null;
  surface_water_temp: number | null;
  bottom_water_temp: number | null;
  visibility: string | null;
  visibility_distance: number | null;
  waves: string | null;
  current: string | null;
  surge: string | null;
  suit: string | null;
  weight: number | null;
  weight_type: string | null;
  equipment: string[] | null;
  cylinder_type: string | null;
  cylinder_size: number | null;
  gas: string | null;
  oxygen_pct: number | null;
  nitrogen_pct: number | null;
  helium_pct: number | null;
  start_pressure: number | null;
  end_pressure: number | null;
  feeling: string | null;
  notes: string | null;
  buddies: string | null;
  dive_center: string | null;
  skills: string[] | null;
}

/** The fields of a DivePatch, which are also DiveState fields with the same name. */
export const PATCH_FIELDS = [
  "title",
  "date",
  "location",
  "dive_type",
  "status",
  "max_depth",
  "bottom_time_min",
  "time_in",
  "time_out",
  "water_type",
  "body_of_water",
  "weather",
  "air_temp",
  "surface_water_temp",
  "bottom_water_temp",
  "visibility",
  "visibility_distance",
  "waves",
  "current",
  "surge",
  "suit",
  "weight",
  "weight_type",
  "equipment",
  "cylinder_type",
  "cylinder_size",
  "gas",
  "oxygen_pct",
  "nitrogen_pct",
  "helium_pct",
  "start_pressure",
  "end_pressure",
  "feeling",
  "notes",
  "buddies",
  "dive_center",
  "adventure_dive",
  "skills",
] as const satisfies ReadonlyArray<keyof DivePatch & keyof DiveState>;

/** The state of a dive as read from PADI (metric). */
export function stateFromWire(w: WireLog): DiveState {
  const dt = w.depth_times?.[0];
  const c = w.conditions?.[0];
  const e = w.equipment?.[0];
  const x = w.experiences?.[0];
  const sk = w.skills?.[0];
  const memsys = wireNumber(w.memsys_member_number);
  const logNumber = wireNumber(w.log_number);
  const equipment = e ? decodePgArray(e.additional_equipment) : [];
  const skills = sk ? decodePgArray(sk.dive_skills) : [];
  return {
    log_type: w.log_type === "Training" ? "Training" : "Recreational",
    course: wireText(w.log_course),
    log_number: logNumber,
    title: w.dive_title ?? "",
    date: fromWireDate(w.dive_date),
    location: w.dive_location ?? "",
    dive_type: wireText(w.dive_type),
    status: w.status ?? "Draft",
    instructor_number: memsys !== null && memsys > 0 ? String(memsys) : null,
    adventure_dive: wireText(w.adventure_dive),
    max_depth: wireNumber(dt?.max_depth),
    bottom_time_min: wireNumber(dt?.bottom_time),
    time_in: wireText(dt?.time_in),
    time_out: wireText(dt?.time_out),
    water_type: wireText(c?.water_type),
    body_of_water: wireText(c?.body_of_water),
    weather: wireText(c?.weather),
    air_temp: wireNumber(c?.air_temp),
    surface_water_temp: wireNumber(c?.surface_water_temp),
    bottom_water_temp: wireNumber(c?.bottom_water_temp),
    visibility: wireText(c?.visibility),
    visibility_distance: wireNumber(c?.visibility_distance),
    waves: wireText(c?.wave_condition),
    current: wireText(c?.current),
    surge: wireText(c?.surge),
    suit: wireText(e?.suit_type),
    weight: wireNumber(e?.weight),
    weight_type: wireText(e?.weight_type),
    equipment: equipment.length ? equipment : null,
    cylinder_type: wireText(e?.cylinder_type),
    cylinder_size: wireNumber(e?.cylinder_size),
    gas: wireText(e?.gas_mixture),
    oxygen_pct: wireNumber(e?.oxygen),
    nitrogen_pct: wireNumber(e?.nitrogen),
    helium_pct: wireNumber(e?.helium),
    start_pressure: wireNumber(e?.starting_pressure),
    end_pressure: wireNumber(e?.ending_pressure),
    feeling: wireText(x?.feeling),
    notes: x?.notes ?? null,
    buddies: wireText(x?.buddies),
    dive_center: wireText(x?.dive_center),
    skills: skills.length ? skills : null,
  };
}

/** An empty state (for a new dive). */
export function emptyState(): DiveState {
  return {
    log_type: "Recreational",
    course: null,
    log_number: null,
    title: "",
    date: "",
    location: "",
    dive_type: null,
    status: "Publish",
    instructor_number: null,
    adventure_dive: null,
    max_depth: null,
    bottom_time_min: null,
    time_in: null,
    time_out: null,
    water_type: null,
    body_of_water: null,
    weather: null,
    air_temp: null,
    surface_water_temp: null,
    bottom_water_temp: null,
    visibility: null,
    visibility_distance: null,
    waves: null,
    current: null,
    surge: null,
    suit: null,
    weight: null,
    weight_type: null,
    equipment: null,
    cylinder_type: null,
    cylinder_size: null,
    gas: null,
    oxygen_pct: null,
    nitrogen_pct: null,
    helium_pct: null,
    start_pressure: null,
    end_pressure: null,
    feeling: null,
    notes: null,
    buddies: null,
    dive_center: null,
    skills: null,
  };
}

/**
 * Merge a change into a state: undefined keeps a field, null clears it, a value sets it. Gas
 * percentages the change does not set follow the gas:
 * - a gas preset (Air, EANx32/36/40) fills them;
 * - clearing the gas, or changing to another custom gas (Enriched, Trimix, Rebreather), clears
 *   them, so the new gas needs its own oxygen_pct (the old percentages belong to the old gas);
 * - a new oxygen_pct or helium_pct of a custom gas clears nitrogen_pct, which is then the rest
 *   to 100 again.
 * The patch must already be metric and normalised.
 */
export function applyPatch(state: DiveState, patch: DivePatch): DiveState {
  const next: DiveState = { ...state };
  const target = next as unknown as Record<string, unknown>;
  for (const key of PATCH_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    target[key] = Array.isArray(value) ? (value.length ? [...value] : null) : value;
  }
  const clearUnset = () => {
    if (patch.oxygen_pct === undefined) next.oxygen_pct = null;
    if (patch.nitrogen_pct === undefined) next.nitrogen_pct = null;
    if (patch.helium_pct === undefined) next.helium_pct = null;
  };
  if (patch.gas !== undefined) {
    const preset = patch.gas ? GAS_PRESETS[patch.gas] : undefined;
    if (preset) {
      if (patch.oxygen_pct === undefined) next.oxygen_pct = preset.oxygen;
      if (patch.nitrogen_pct === undefined) next.nitrogen_pct = preset.nitrogen;
      if (patch.helium_pct === undefined) next.helium_pct = preset.helium;
    } else if (patch.gas === null || patch.gas !== state.gas) {
      clearUnset();
    }
  }
  const custom = next.gas !== null && isEnumValue("gas", next.gas) && !GAS_PRESETS[next.gas];
  if (custom && patch.nitrogen_pct === undefined && (patch.oxygen_pct !== undefined || patch.helium_pct !== undefined)) {
    next.nitrogen_pct = null;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

function memsysValue(value: string | null): number | string | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

function depthTimeSet(s: DiveState, withTimes: boolean): WireDepthTimeSet {
  return {
    max_depth: s.max_depth,
    bottom_time: s.bottom_time_min,
    ...(withTimes ? { time_in: s.time_in, time_out: s.time_out } : {}),
  };
}

function conditionsSet(s: DiveState): WireConditionsSet {
  return {
    water_type: s.water_type as WireConditionsSet["water_type"],
    body_of_water: s.body_of_water as WireConditionsSet["body_of_water"],
    weather: s.weather as WireConditionsSet["weather"],
    air_temp: s.air_temp,
    surface_water_temp: s.surface_water_temp,
    bottom_water_temp: s.bottom_water_temp,
    visibility: s.visibility as WireConditionsSet["visibility"],
    visibility_distance: s.visibility_distance,
    wave_condition: s.waves as WireConditionsSet["wave_condition"],
    current: s.current as WireConditionsSet["current"],
    surge: s.surge as WireConditionsSet["surge"],
  };
}

function equipmentSet(s: DiveState): WireEquipmentSet {
  return {
    suit_type: s.suit as WireEquipmentSet["suit_type"],
    weight: s.weight,
    weight_type: s.weight_type as WireEquipmentSet["weight_type"],
    additional_equipment: encodePgArray(s.equipment),
    cylinder_type: s.cylinder_type as WireEquipmentSet["cylinder_type"],
    cylinder_size: s.cylinder_size,
    gas_mixture: s.gas as WireEquipmentSet["gas_mixture"],
    oxygen: s.oxygen_pct,
    nitrogen: s.nitrogen_pct,
    helium: s.helium_pct,
    starting_pressure: s.start_pressure,
    ending_pressure: s.end_pressure,
  };
}

function experienceSet(s: DiveState): WireExperienceSet {
  return {
    feeling: s.feeling as WireExperienceSet["feeling"],
    notes: s.notes,
    buddies: s.buddies,
    dive_center: s.dive_center,
  };
}

function skillsSet(s: DiveState): WireSkillsSet {
  return { dive_skills: encodePgArray(s.skills) };
}

/** The nested insert payload of a new dive (the state must be validated). */
export function buildInsert(s: DiveState, now: Date = new Date()): WireLogInsert {
  const stamp = utcTimestamp(now);
  const training = s.log_type === "Training";
  const payload: WireLogInsert = {
    log_type: s.log_type,
    log_course: training ? (s.course as TrainingCourse) : null,
    log_number: training ? s.log_number : null,
    created_date: stamp,
    update_date: stamp,
    dive_type: s.dive_type as DiveType,
    dive_title: s.title,
    dive_location: s.location,
    dive_date: toWireDate(s.date),
    status: s.status as DiveStatus,
    memsys_member_number: memsysValue(s.instructor_number),
    ...(training || s.adventure_dive ? { adventure_dive: s.adventure_dive } : {}),
    depth_times: { data: depthTimeSet(s, s.time_in !== null || s.time_out !== null) },
    conditions: { data: conditionsSet(s) },
    equipment: { data: equipmentSet(s) },
    experiences: { data: experienceSet(s) },
  };
  if (training) payload.skills = { data: skillsSet(s) };
  return payload;
}

/** The child relations a dive has no row for. */
export function missingChildren(existing: WireLog): ChildTable[] {
  const rels: ChildTable[] = ["depth_times", "conditions", "equipment", "experiences", "skills"];
  return rels.filter((rel) => !existing[rel]?.length);
}

export interface BuildUpdateOptions {
  /** Also write time_in and time_out (only when the change set them). */
  withTimes?: boolean;
  /** Also write the skills row (only when the change set the skills). */
  withSkills?: boolean;
}

/**
 * The update of an existing dive to a new (merged, validated) state. Every column of conditions,
 * equipment and experience is written (PADI's own app does the same, so a missing column would be
 * null). log_type and created_date are never sent. Child rows the dive does not have are listed
 * in `missing`, to be inserted.
 */
export function buildUpdate(existing: WireLog, s: DiveState, now: Date = new Date(), opts: BuildUpdateOptions = {}): WireLogUpdate {
  const training = s.log_type === "Training";
  const general: WireLogSet = {
    log_course: training ? (s.course as TrainingCourse | null) : null,
    log_number: training ? s.log_number : null,
    update_date: utcTimestamp(now),
    dive_type: s.dive_type as DiveType,
    dive_title: s.title,
    dive_location: s.location,
    dive_date: toWireDate(s.date),
    status: s.status as DiveStatus,
    memsys_member_number: memsysValue(s.instructor_number),
    // Kept as it is unless changed (PADI's recreational form would erase it).
    adventure_dive: s.adventure_dive,
  };
  // A recreational dive keeps what PADI has in log_number (some apps store 0).
  if (!training) general.log_number = existing.log_number === null || existing.log_number === undefined ? null : (wireNumber(existing.log_number) ?? null);
  const missing = missingChildren(existing).filter((rel) => rel !== "skills" || opts.withSkills);
  const update: WireLogUpdate = {
    id: existing.id,
    general: { ...general },
    depthTime: { ...depthTimeSet(s, !!opts.withTimes) },
    conditions: { ...conditionsSet(s) },
    equipment: { ...equipmentSet(s) },
    experience: { ...experienceSet(s) },
    ...(opts.withSkills ? { skills: { ...skillsSet(s) } } : {}),
  };
  if (missing.length) update.missing = missing;
  return update;
}

// ---------------------------------------------------------------------------------------------
// Reading: wire -> domain
// ---------------------------------------------------------------------------------------------

function convert(quantity: Quantity, value: number | null | undefined, system: UnitSystem): number | undefined {
  return value === null || value === undefined ? undefined : fromMetric(quantity, value, system);
}

/** One dive of a list, in the caller's units. */
export function toDiveSummary(w: WireLogSummary, system: UnitSystem): DiveSummary {
  const logType: LogType = w.log_type === "Training" ? "Training" : "Recreational";
  const dt = w.depth_times?.[0];
  const logNumber = wireNumber(w.log_number);
  const out: DiveSummary = {
    id: w.id,
    title: (w.dive_title ?? "").trim(),
    date: fromWireDate(w.dive_date),
    location: (w.dive_location ?? "").trim(),
    type: logType,
    status: w.status ?? "Draft",
    locked: isLocked(w.status),
  };
  if (w.dive_type) out.dive_type = w.dive_type as DiveType;
  if (logType === "Training" && w.log_course) out.course = w.log_course;
  if (logType === "Training" && logNumber !== null && logNumber > 0) out.log_number = logNumber;
  const depth = convert("depth", wireNumber(dt?.max_depth), system);
  if (depth !== undefined) out.max_depth = depth;
  const time = wireNumber(dt?.bottom_time);
  if (time !== null) out.bottom_time_min = time;
  return out;
}

/** A full dive in the caller's units. Fields without a value are left out. */
export function toDive(w: WireLog, system: UnitSystem): Dive {
  const s = stateFromWire(w);
  const summary = toDiveSummary(w, system);
  const dive: Dive = { ...summary, units: unitLabels(system), web_url: diveWebUrl(w.id, s.log_type) };
  const set = <K extends keyof Dive>(key: K, value: Dive[K] | null | undefined) => {
    if (value !== null && value !== undefined && !(typeof value === "string" && value === "")) dive[key] = value;
  };
  set("time_in", s.time_in ?? undefined);
  set("time_out", s.time_out ?? undefined);
  set("water_type", s.water_type);
  set("body_of_water", s.body_of_water);
  set("weather", s.weather);
  set("air_temp", convert("temp", s.air_temp, system));
  set("surface_water_temp", convert("temp", s.surface_water_temp, system));
  set("bottom_water_temp", convert("temp", s.bottom_water_temp, system));
  set("visibility", s.visibility);
  set("visibility_distance", convert("depth", s.visibility_distance, system));
  set("waves", s.waves);
  set("current", s.current);
  set("surge", s.surge);
  set("suit", s.suit);
  set("weight", convert("weight", s.weight, system));
  set("weight_type", s.weight_type);
  if (s.equipment?.length) dive.equipment = [...s.equipment];
  set("cylinder_type", s.cylinder_type);
  set("cylinder_size", convert("volume", s.cylinder_size, system));
  set("gas", s.gas);
  if (s.gas || (s.oxygen_pct ?? 0) > 0) {
    set("oxygen_pct", s.oxygen_pct);
    set("nitrogen_pct", s.nitrogen_pct);
    set("helium_pct", s.helium_pct);
  }
  set("start_pressure", convert("pressure", s.start_pressure, system));
  set("end_pressure", convert("pressure", s.end_pressure, system));
  if (s.start_pressure !== null && s.end_pressure !== null) dive.pressure_used = fromMetric("pressure", s.start_pressure - s.end_pressure, system);
  set("feeling", s.feeling);
  set("notes", s.notes);
  set("buddies", s.buddies);
  set("dive_center", s.dive_center);
  set("instructor_number", s.instructor_number);
  set("adventure_dive", s.adventure_dive);
  if (s.skills?.length) dive.skills = [...s.skills];
  return dive;
}
