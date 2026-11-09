/**
 * THE CONTRACT of MCP for PADI: the shapes every other module codes against.
 *
 * Three levels:
 * - enums: string literal unions with the values exactly as PADI stores them (case-sensitive);
 * - wire: the GraphQL shapes of the PADI logbook (Hasura on Postgres). Numbers may arrive as JSON
 *   strings, child relations are arrays (read item [0]), and rows may be missing;
 * - domain: what the MCP tools accept and return (friendly snake_case names, the caller's units).
 *
 * The facts behind these types are in docs/padi-api.md (sections 3 and 4). Stored values are
 * always metric: m, min, degrees C, bar, kg, litres.
 */

// ---------------------------------------------------------------------------------------------
// Enums (values exactly as PADI stores them)
// ---------------------------------------------------------------------------------------------

export type LogType = "Recreational" | "Training";
export type DiveStatus = "Draft" | "Publish" | "Pending" | "Resubmit" | "Verified" | "QR Code Verified";
export type DiveType = "Boat" | "BeachShore" | "Other";
export type WaterType = "Salt" | "Fresh";
export type BodyOfWater = "Ocean" | "Lake" | "Quarry" | "River" | "Other";
export type Weather = "Sunny" | "Partly Cloudy" | "Cloudy" | "Rainy" | "Windy" | "Foggy";
export type Visibility = "High" | "Average" | "Low";
export type WaveCondition = "NoWaves" | "SmallWaves" | "MediumWaves" | "LargeWaves";
export type Current = "NoCurrent" | "SomeCurrent" | "MediumCurrent" | "StrongCurrent";
export type Surge = "SomeSurge" | "MediumSurge" | "BigSurge";
export type SuitType = "NoExposure" | "FullSuit_3mm" | "FullSuit_5mm" | "FullSuit_7mm" | "Shorty" | "SemiDrySuit" | "DrySuit";
export type WeightType = "Light" | "Good" | "Heavy";
export type CylinderType = "Steel" | "Aluminum" | "Other";
export type GasMixture = "Air" | "Enriched_32" | "Enriched_36" | "Enriched_40" | "Enriched" | "Trimix" | "Rebreather";
export type Feeling = "Amazing" | "Good" | "Average" | "Poor";
export type TrainingCourse = "Open" | "Advanced" | "Rescue" | "DSD" | "Reactivate" | "SpecialtyAndDistinctive";
/** The PADI logbook display setting (logbook_units_settings.unit). Display only: values stay metric. */
export type Units = "Metric" | "Imperial";

/** Units the tools speak. */
export type UnitSystem = "metric" | "imperial";
/** A unit choice: "auto" means the PADI logbook display setting. */
export type UnitChoice = "auto" | UnitSystem;

/** Dives with these statuses are locked: the MCP refuses to change or delete them. */
export type LockedStatus = Extract<DiveStatus, "Pending" | "Verified" | "QR Code Verified">;

// ---------------------------------------------------------------------------------------------
// Wire level: read shapes (exactly what the GraphQL queries return)
// ---------------------------------------------------------------------------------------------

/** A numeric column as read: a JSON number, a numeric string, or null. */
export type WireNumber = number | string | null;

/** A logbook_logs row with the columns of the list query (and, optionally, depth and time). */
export interface WireLogSummary {
  id: number;
  log_type: LogType | null;
  log_course: string | null;
  log_number: number | null;
  dive_title: string | null;
  /** Naive datetime "YYYY-MM-DDTHH:MM:SS"; keep the date part only. */
  dive_date: string | null;
  dive_location: string | null;
  status: DiveStatus | string | null;
  dive_type?: string | null;
  depth_times?: Array<{ max_depth: WireNumber; bottom_time: WireNumber }>;
}

/** logbook_depth_time. max_depth in m, bottom_time in whole minutes. */
export interface WireDepthTime {
  id?: number;
  logs_id?: number;
  max_depth: WireNumber;
  bottom_time: WireNumber;
  /** Never written by the PADI web app; format unknown (probably set by the mobile app). */
  time_in?: string | number | null;
  time_out?: string | number | null;
}

/** logbook_conditions. Temperatures in degrees C, visibility_distance in m. */
export interface WireConditions {
  id?: number;
  logs_id?: number;
  water_type: WaterType | string | null;
  body_of_water: BodyOfWater | string | null;
  weather: Weather | string | null;
  air_temp: WireNumber;
  surface_water_temp: WireNumber;
  bottom_water_temp: WireNumber;
  visibility: Visibility | string | null;
  visibility_distance: WireNumber;
  wave_condition: WaveCondition | string | null;
  current: Current | string | null;
  /** "NoSurge" is accepted by the API but not offered by the PADI web app. */
  surge: Surge | string | null;
}

/** logbook_equipment. weight in kg, cylinder_size in litres, pressures in bar, gas in %. */
export interface WireEquipment {
  id?: number;
  logs_id?: number;
  suit_type: SuitType | string | null;
  weight: WireNumber;
  weight_type: WeightType | string | null;
  /** Postgres text[]: read as a JSON array (a literal string such as "{Hood,Boots}" is tolerated). */
  additional_equipment: string[] | string | null;
  cylinder_type: CylinderType | string | null;
  cylinder_size: WireNumber;
  /** "Nitrox" and "Heliox" are accepted by the API but not offered by the PADI web app. */
  gas_mixture: GasMixture | string | null;
  oxygen: WireNumber;
  nitrogen: WireNumber;
  helium: WireNumber;
  starting_pressure: WireNumber;
  ending_pressure: WireNumber;
}

/** logbook_experience (the relation is named "experiences"). */
export interface WireExperience {
  id?: number;
  logs_id?: number;
  feeling: Feeling | string | null;
  notes: string | null;
  /** One free-text string, despite the plural name. */
  buddies: string | null;
  dive_center: string | null;
}

/** logbook_skills. */
export interface WireSkills {
  id?: number;
  logs_id?: number;
  /** Postgres text[]: read as a JSON array. */
  dive_skills: string[] | string | null;
}

/**
 * A full logbook_logs row (the "get one dive" query, or listLogs with full=true).
 *
 * The five child relations are arrays: read [0]. A relation can be empty (a training dive often
 * has no skills row; a dive created in two steps may lack any child row). Fields that the query
 * did not select are absent, so every field beyond the summary is optional.
 */
export interface WireLog extends WireLogSummary {
  affiliate_id?: number | string | null;
  /** PADI Pro member number for verification. Read as a JSON number. */
  memsys_member_number?: number | string | null;
  adventure_dive?: string | null;
  /** UTC wall clock "YYYY-MM-DDTHH:mm:ss" without Z. Not selected by the PADI web app. */
  created_date?: string | null;
  update_date?: string | null;
  depth_times?: WireDepthTime[];
  conditions?: WireConditions[];
  equipment?: WireEquipment[];
  experiences?: WireExperience[];
  skills?: WireSkills[];
}

// ---------------------------------------------------------------------------------------------
// Wire level: write shapes
// ---------------------------------------------------------------------------------------------

/** A numeric value as written. The PADI web app sends strings ("28", "30.000"); numbers also work. */
export type WireNumberInput = number | string | null;

/** logbook_depth_time columns as written. time_in/time_out only when the caller gave them. */
export type WireDepthTimeSet = {
  max_depth?: WireNumberInput;
  bottom_time?: WireNumberInput;
  time_in?: string | null;
  time_out?: string | null;
};

/** logbook_conditions columns as written (all of them on every update: the row is overwritten). */
export type WireConditionsSet = {
  water_type?: WaterType | null;
  body_of_water?: BodyOfWater | null;
  weather?: Weather | null;
  air_temp?: WireNumberInput;
  surface_water_temp?: WireNumberInput;
  bottom_water_temp?: WireNumberInput;
  visibility?: Visibility | null;
  visibility_distance?: WireNumberInput;
  wave_condition?: WaveCondition | null;
  current?: Current | null;
  surge?: Surge | null;
};

/** logbook_equipment columns as written. */
export type WireEquipmentSet = {
  suit_type?: SuitType | null;
  weight?: WireNumberInput;
  weight_type?: WeightType | null;
  /** A Postgres array literal string such as "{Hood,Gloves}" (items quoted when needed), or null. */
  additional_equipment?: string | null;
  cylinder_type?: CylinderType | null;
  cylinder_size?: WireNumberInput;
  gas_mixture?: GasMixture | null;
  oxygen?: WireNumberInput;
  nitrogen?: WireNumberInput;
  helium?: WireNumberInput;
  starting_pressure?: WireNumberInput;
  ending_pressure?: WireNumberInput;
};

/** logbook_experience columns as written. */
export type WireExperienceSet = {
  feeling?: Feeling | null;
  notes?: string | null;
  buddies?: string | null;
  dive_center?: string | null;
};

/** logbook_skills columns as written. */
export type WireSkillsSet = {
  /** A Postgres array literal string such as "{no skills}", or null. */
  dive_skills?: string | null;
};

/**
 * logbook_logs columns as written by an update (`_set`). Never contains log_type (the PADI web
 * app strips it) or created_date. affiliate_id is added by the backend from the token.
 */
export type WireLogSet = {
  log_course?: TrainingCourse | null;
  log_number?: number | null;
  update_date?: string;
  dive_type?: DiveType;
  dive_title?: string;
  dive_location?: string;
  /** "MM/DD/YYYY". */
  dive_date?: string;
  status?: DiveStatus;
  memsys_member_number?: string | number | null;
  adventure_dive?: string | null;
};

/**
 * The nested insert payload ($general of insert_logbook_logs). Child rows are nested as
 * `{ data: {...} }`. The caller never sets affiliate_id: the backend always puts in the one from
 * the token (the PADI web app sends it inside $general on both endpoints).
 */
export interface WireLogInsert {
  affiliate_id?: string | number;
  log_type: LogType;
  log_course: TrainingCourse | null;
  log_number: number | null;
  /** UTC "YYYY-MM-DDTHH:mm:ss" without Z. */
  created_date: string;
  update_date: string;
  dive_type: DiveType;
  dive_title: string;
  dive_location: string;
  /** "MM/DD/YYYY". */
  dive_date: string;
  status: DiveStatus;
  memsys_member_number: string | number | null;
  adventure_dive?: string | null;
  depth_times: { data: WireDepthTimeSet };
  conditions: { data: WireConditionsSet };
  equipment: { data: WireEquipmentSet };
  experiences: { data: WireExperienceSet };
  /** Training dives only. */
  skills?: { data: WireSkillsSet };
}

/** A child table of logbook_logs, by its relation name. */
export type ChildTable = "depth_times" | "conditions" | "equipment" | "experiences" | "skills";

/**
 * One update of a dive: the variables of the update mutation. The service reads the dive first
 * and merges the change, so conditions, equipment and experience hold every column (a missing
 * column would be written as null by PADI's own app). The typed *Set shapes above fit here.
 */
export interface WireLogUpdate {
  id: number;
  general: Record<string, unknown>;
  depthTime: Record<string, unknown>;
  conditions: Record<string, unknown>;
  equipment: Record<string, unknown>;
  experience: Record<string, unknown>;
  /** Training dives with skills. */
  skills?: Record<string, unknown>;
  /** Child tables that have no row yet and must be inserted instead of updated. */
  missing?: ChildTable[];
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

export interface ListQuery {
  /** null or undefined: no limit (every dive). */
  limit?: number | null;
  offset?: number;
  /** PADI filters by log_type or by status, never both. */
  logType?: LogType;
  status?: DiveStatus;
  /** Always descending (newest, deepest, longest first). Default "date". */
  orderBy?: "date" | "max_depth" | "bottom_time";
  /** Also select depth_times { max_depth bottom_time } and dive_type. */
  withDepthTime?: boolean;
  /** Select every column and child relation (export, stats). */
  full?: boolean;
}

export interface DiveSite {
  id: number;
  name: string;
}

export interface InstructorMatch {
  memberNumber: number;
  name: string;
}

export interface BackendCheck {
  ok: boolean;
  error?: string;
  dives?: number;
  apiMode?: string;
}

/** Raw operations against PADI (or the demo). No validation, no unit conversion. */
export interface LogbookBackend {
  readonly kind: "padi" | "demo";
  /** full=true selects all nested fields (export, stats). */
  listLogs(q: ListQuery): Promise<WireLog[]>;
  countLogs(filter?: { logType?: LogType; status?: DiveStatus }): Promise<number>;
  /** Sum of bottom_time in minutes, or null when there is nothing to sum. */
  totalBottomTime(): Promise<number | null>;
  /** undefined: no such dive, or not the user's. */
  getLog(id: number): Promise<WireLog | undefined>;
  /** Returns the new id. */
  insertLog(payload: WireLogInsert): Promise<number>;
  updateLog(update: WireLogUpdate): Promise<void>;
  /** Deletes the 5 child tables by logs_id, then the log, in one mutation. */
  deleteLog(id: number): Promise<void>;
  /** `pattern` is an SQL LIKE pattern, for example "%reef%". */
  searchSites(pattern: string, limit: number): Promise<DiveSite[]>;
  /** "Metric" when no row exists. */
  getUnits(): Promise<Units>;
  setUnits(units: Units): Promise<void>;
  /** Empty when the number is unknown. */
  lookupInstructor(memberNumber: string): Promise<InstructorMatch[]>;
  listCertifications(): Promise<Certification[]>;
  listPhotoIds(logId: number): Promise<string[]>;
  getPhoto(logId: number, photoId: string): Promise<{ data: Buffer; mimeType: string }>;
  /** From the token claims (no network for the demo). */
  account(): Promise<PadiAccount>;
  check(): Promise<BackendCheck>;
  close(): Promise<void>;
}

export interface PadiAccount {
  affiliateId: string;
  email?: string;
  name?: string;
  isPro: boolean;
  loginMethod?: string;
  apiMode?: string;
  /** ISO 8601. */
  tokenExpiresAt?: string;
}

/** A PADI eCard. */
export interface Certification {
  title: string;
  certDate?: string;
  padiNumber?: string;
  instructorName?: string;
  instructorNumber?: string;
  storeName?: string;
  cardImageUrl?: string;
  licenseId?: string;
}

// ---------------------------------------------------------------------------------------------
// Domain level (what tools return and accept)
// ---------------------------------------------------------------------------------------------

/** Unit labels of a domain answer. */
export interface DiveUnits {
  depth: "m" | "ft";
  temp: "C" | "F";
  pressure: "bar" | "psi";
  weight: "kg" | "lb";
  volume: "l" | "cuft";
}

/** One dive in a list. Numbers are in the units of the answer. */
export interface DiveSummary {
  id: number;
  title: string;
  /** YYYY-MM-DD (a calendar date, no time zone). */
  date: string;
  location: string;
  type: LogType;
  status: DiveStatus | string;
  dive_type?: DiveType;
  /** Training dives: the course (TrainingCourse value). */
  course?: string;
  log_number?: number;
  max_depth?: number;
  bottom_time_min?: number;
  /** Pending, Verified or QR Code Verified: cannot be changed or deleted. */
  locked: boolean;
}

/**
 * A full dive. Every value is in the units listed in `units`. Fields without a value are left out.
 * Enum fields hold the PADI value; a value this server does not know is passed through as it is.
 */
export interface Dive extends DiveSummary {
  units: DiveUnits;
  time_in?: string;
  time_out?: string;
  // Conditions
  water_type?: WaterType | string;
  body_of_water?: BodyOfWater | string;
  weather?: Weather | string;
  air_temp?: number;
  surface_water_temp?: number;
  bottom_water_temp?: number;
  visibility?: Visibility | string;
  visibility_distance?: number;
  waves?: WaveCondition | string;
  current?: Current | string;
  surge?: Surge | string;
  // Equipment
  suit?: SuitType | string;
  weight?: number;
  weight_type?: WeightType | string;
  /** Extra equipment, for example ["Hood", "Gloves"]. */
  equipment?: string[];
  cylinder_type?: CylinderType | string;
  cylinder_size?: number;
  gas?: GasMixture | string;
  oxygen_pct?: number;
  nitrogen_pct?: number;
  helium_pct?: number;
  start_pressure?: number;
  end_pressure?: number;
  /** start_pressure - end_pressure, when both are known. */
  pressure_used?: number;
  // Experience
  feeling?: Feeling | string;
  notes?: string;
  buddies?: string;
  dive_center?: string;
  // Verification and training
  /** PADI Pro member number the dive was sent to (memsys_member_number). */
  instructor_number?: string;
  adventure_dive?: string;
  skills?: string[];
  /** Where to see or edit the dive on learning.padi.com. */
  web_url: string;
}

/** Training part of a new dive. */
export interface TrainingInput {
  course: TrainingCourse;
  /** 1-13 (see the course catalogue); null or absent for Specialty. */
  log_number?: number | null;
  /** Required for Advanced Open Water elective dives (log numbers 7-9). */
  adventure_dive?: string;
  skills?: string[];
}

/**
 * A new dive, as the tools accept it. Numbers are in the units of the call. Required: title,
 * date, location, dive_type, and (unless status is Draft) max_depth and bottom_time_min.
 */
export interface DiveInput {
  title: string;
  /** YYYY-MM-DD, not in the future. */
  date: string;
  location: string;
  dive_type: DiveType;
  /** Default Publish. Training dives are saved as Draft. */
  status?: "Publish" | "Draft";
  max_depth?: number;
  bottom_time_min?: number;
  time_in?: string;
  time_out?: string;
  water_type?: WaterType;
  body_of_water?: BodyOfWater;
  weather?: Weather;
  air_temp?: number;
  surface_water_temp?: number;
  bottom_water_temp?: number;
  visibility?: Visibility;
  visibility_distance?: number;
  waves?: WaveCondition;
  current?: Current;
  surge?: Surge;
  suit?: SuitType;
  weight?: number;
  weight_type?: WeightType;
  equipment?: string[];
  cylinder_type?: CylinderType;
  cylinder_size?: number;
  /** Presets fill the percentages; a custom gas needs all three, summing to 100. */
  gas?: GasMixture;
  oxygen_pct?: number;
  nitrogen_pct?: number;
  helium_pct?: number;
  start_pressure?: number;
  end_pressure?: number;
  feeling?: Feeling;
  notes?: string;
  buddies?: string;
  dive_center?: string;
  training?: TrainingInput;
}

/**
 * A change to a dive: any field of DiveInput. `null` clears an optional field. The required
 * fields (title, date, location, dive_type) cannot be cleared.
 */
export interface DivePatch {
  title?: string;
  date?: string;
  location?: string;
  dive_type?: DiveType;
  status?: "Publish" | "Draft";
  max_depth?: number | null;
  bottom_time_min?: number | null;
  time_in?: string | null;
  time_out?: string | null;
  water_type?: WaterType | null;
  body_of_water?: BodyOfWater | null;
  weather?: Weather | null;
  air_temp?: number | null;
  surface_water_temp?: number | null;
  bottom_water_temp?: number | null;
  visibility?: Visibility | null;
  visibility_distance?: number | null;
  waves?: WaveCondition | null;
  current?: Current | null;
  surge?: Surge | null;
  suit?: SuitType | null;
  weight?: number | null;
  weight_type?: WeightType | null;
  equipment?: string[] | null;
  cylinder_type?: CylinderType | null;
  cylinder_size?: number | null;
  gas?: GasMixture | null;
  oxygen_pct?: number | null;
  nitrogen_pct?: number | null;
  helium_pct?: number | null;
  start_pressure?: number | null;
  end_pressure?: number | null;
  feeling?: Feeling | null;
  notes?: string | null;
  buddies?: string | null;
  dive_center?: string | null;
  adventure_dive?: string | null;
  skills?: string[] | null;
}
