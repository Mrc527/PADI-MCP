/**
 * The PADI logbook enums: the values exactly as PADI stores them, human labels, and lenient input
 * aliases ("shore" -> BeachShore, "3mm" -> FullSuit_3mm, "nitrox 32" -> Enriched_32, ...).
 *
 * Matching ignores case, spaces, "_", "-", "/", "." and "%". A few aliases mean "no value" (for
 * example "none" for surge): they map to null.
 */

import type {
  BodyOfWater,
  Current,
  CylinderType,
  DiveStatus,
  DiveType,
  Feeling,
  GasMixture,
  LockedStatus,
  LogType,
  Surge,
  SuitType,
  TrainingCourse,
  Units,
  Visibility,
  WaterType,
  WaveCondition,
  Weather,
  WeightType,
} from "./types.js";

interface EnumDef<V extends string> {
  /** Values as PADI stores them. */
  values: readonly V[];
  /** Human labels (English). */
  labels: Readonly<Record<V, string>>;
  /** Extra input spellings (already in key form, see enumKey) and what they mean. */
  aliases: Readonly<Record<string, V | null>>;
}

/** The matching key of an input: lowercase, without spaces and separators. */
export function enumKey(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-/.%()+]+/g, "");
}

function def<V extends string>(values: readonly V[], labels: Record<V, string>, aliases: Record<string, V | null> = {}): EnumDef<V> {
  return { values, labels, aliases };
}

export const ENUMS = {
  log_type: def<LogType>(["Recreational", "Training"], { Recreational: "Recreational", Training: "Training" }, { rec: "Recreational", fun: "Recreational", fundive: "Recreational", course: "Training" }),
  status: def<DiveStatus>(
    ["Draft", "Publish", "Pending", "Resubmit", "Verified", "QR Code Verified"],
    {
      Draft: "Draft",
      Publish: "Logged",
      Pending: "Waiting for verification",
      Resubmit: "Sent back by the PADI Pro",
      Verified: "Verified",
      "QR Code Verified": "Verified with a QR code",
    },
    { published: "Publish", logged: "Publish", drafts: "Draft", qrverified: "QR Code Verified", qr: "QR Code Verified" },
  ),
  dive_type: def<DiveType>(["Boat", "BeachShore", "Other"], { Boat: "Boat", BeachShore: "Shore", Other: "Other" }, {
    shore: "BeachShore",
    beach: "BeachShore",
    shoredive: "BeachShore",
    beachdive: "BeachShore",
    fromshore: "BeachShore",
    boatdive: "Boat",
    liveaboard: "Boat",
  }),
  water_type: def<WaterType>(["Salt", "Fresh"], { Salt: "Salt water", Fresh: "Fresh water" }, { saltwater: "Salt", sea: "Salt", seawater: "Salt", freshwater: "Fresh" }),
  body_of_water: def<BodyOfWater>(["Ocean", "Lake", "Quarry", "River", "Other"], { Ocean: "Ocean", Lake: "Lake", Quarry: "Quarry", River: "River", Other: "Other" }, {
    sea: "Ocean",
    pool: "Other",
  }),
  weather: def<Weather>(
    ["Sunny", "Partly Cloudy", "Cloudy", "Rainy", "Windy", "Foggy"],
    { Sunny: "Sunny", "Partly Cloudy": "Partly cloudy", Cloudy: "Cloudy", Rainy: "Rainy", Windy: "Windy", Foggy: "Foggy" },
    { sun: "Sunny", clear: "Sunny", partlysunny: "Partly Cloudy", overcast: "Cloudy", rain: "Rainy", wind: "Windy", fog: "Foggy", mist: "Foggy", misty: "Foggy" },
  ),
  visibility: def<Visibility>(["High", "Average", "Low"], { High: "Good (high)", Average: "Average", Low: "Poor (low)" }, {
    good: "High",
    great: "High",
    excellent: "High",
    medium: "Average",
    moderate: "Average",
    ok: "Average",
    poor: "Low",
    bad: "Low",
  }),
  waves: def<WaveCondition>(
    ["NoWaves", "SmallWaves", "MediumWaves", "LargeWaves"],
    { NoWaves: "No waves", SmallWaves: "Small waves", MediumWaves: "Medium waves", LargeWaves: "Large waves" },
    { none: "NoWaves", no: "NoWaves", calm: "NoWaves", flat: "NoWaves", small: "SmallWaves", medium: "MediumWaves", large: "LargeWaves", big: "LargeWaves", bigwaves: "LargeWaves" },
  ),
  current: def<Current>(
    ["NoCurrent", "SomeCurrent", "MediumCurrent", "StrongCurrent"],
    { NoCurrent: "No current", SomeCurrent: "Light current", MediumCurrent: "Medium current", StrongCurrent: "Strong current" },
    {
      none: "NoCurrent",
      no: "NoCurrent",
      light: "SomeCurrent",
      lightcurrent: "SomeCurrent",
      some: "SomeCurrent",
      weak: "SomeCurrent",
      weakcurrent: "SomeCurrent",
      mild: "SomeCurrent",
      low: "SomeCurrent",
      medium: "MediumCurrent",
      moderate: "MediumCurrent",
      moderatecurrent: "MediumCurrent",
      strong: "StrongCurrent",
      high: "StrongCurrent",
    },
  ),
  surge: def<Surge>(
    ["SomeSurge", "MediumSurge", "BigSurge"],
    { SomeSurge: "Light surge", MediumSurge: "Medium surge", BigSurge: "Strong surge" },
    {
      none: null,
      no: null,
      nosurge: null,
      light: "SomeSurge",
      lightsurge: "SomeSurge",
      some: "SomeSurge",
      weak: "SomeSurge",
      medium: "MediumSurge",
      moderate: "MediumSurge",
      strong: "BigSurge",
      strongsurge: "BigSurge",
      big: "BigSurge",
      high: "BigSurge",
    },
  ),
  suit: def<SuitType>(
    ["NoExposure", "FullSuit_3mm", "FullSuit_5mm", "FullSuit_7mm", "Shorty", "SemiDrySuit", "DrySuit"],
    {
      NoExposure: "No exposure suit",
      FullSuit_3mm: "3 mm full wetsuit",
      FullSuit_5mm: "5 mm full wetsuit",
      FullSuit_7mm: "7 mm full wetsuit",
      Shorty: "Shorty",
      SemiDrySuit: "Semi-dry suit",
      DrySuit: "Dry suit",
    },
    {
      none: "NoExposure",
      no: "NoExposure",
      nosuit: "NoExposure",
      swimsuit: "NoExposure",
      ...Object.fromEntries(
        (["3", "5", "7"] as const).flatMap((mm) => {
          const v = `FullSuit_${mm}mm` as SuitType;
          return [`${mm}mm`, `${mm}mmwetsuit`, `wetsuit${mm}mm`, `${mm}mmfullsuit`, `${mm}mmfull`, `full${mm}mm`, `${mm}mmsuit`].map((k) => [k, v]);
        }),
      ),
      shortie: "Shorty",
      short: "Shorty",
      semidry: "SemiDrySuit",
      semi: "SemiDrySuit",
      dry: "DrySuit",
    },
  ),
  weight_type: def<WeightType>(["Light", "Good", "Heavy"], { Light: "Too light", Good: "Good", Heavy: "Too heavy" }, {
    under: "Light",
    underweighted: "Light",
    toolight: "Light",
    ok: "Good",
    okay: "Good",
    right: "Good",
    correct: "Good",
    perfect: "Good",
    over: "Heavy",
    overweighted: "Heavy",
    tooheavy: "Heavy",
  }),
  cylinder_type: def<CylinderType>(["Steel", "Aluminum", "Other"], { Steel: "Steel", Aluminum: "Aluminium", Other: "Other" }, {
    aluminium: "Aluminum",
    alu: "Aluminum",
    al: "Aluminum",
  }),
  gas: def<GasMixture>(
    ["Air", "Enriched_32", "Enriched_36", "Enriched_40", "Enriched", "Trimix", "Rebreather"],
    {
      Air: "Air (21% oxygen)",
      Enriched_32: "Nitrox EANx32 (32% oxygen)",
      Enriched_36: "Nitrox EANx36 (36% oxygen)",
      Enriched_40: "Nitrox EANx40 (40% oxygen)",
      Enriched: "Nitrox, other mix",
      Trimix: "Trimix",
      Rebreather: "Rebreather",
    },
    {
      ...Object.fromEntries(
        (["32", "36", "40"] as const).flatMap((p) => {
          const v = `Enriched_${p}` as GasMixture;
          return [`ean${p}`, `eanx${p}`, `nitrox${p}`, `enriched${p}`, `enrichedair${p}`, `ea${p}`].map((k) => [k, v]);
        }),
      ),
      nitrox: "Enriched",
      ean: "Enriched",
      eanx: "Enriched",
      enrichedair: "Enriched",
      customnitrox: "Enriched",
      tx: "Trimix",
      ccr: "Rebreather",
      scr: "Rebreather",
    },
  ),
  feeling: def<Feeling>(["Amazing", "Good", "Average", "Poor"], { Amazing: "Amazing", Good: "Good", Average: "Average", Poor: "Poor" }, {
    great: "Amazing",
    excellent: "Amazing",
    awesome: "Amazing",
    fantastic: "Amazing",
    fine: "Good",
    nice: "Good",
    ok: "Average",
    okay: "Average",
    bad: "Poor",
  }),
  course: def<TrainingCourse>(
    ["Open", "Advanced", "Rescue", "DSD", "Reactivate", "SpecialtyAndDistinctive"],
    {
      Open: "Open Water Diver",
      Advanced: "Advanced Open Water",
      Rescue: "Rescue Diver",
      DSD: "Discover Scuba Diving",
      Reactivate: "ReActivate",
      SpecialtyAndDistinctive: "Specialty / Distinctive",
    },
    {
      openwater: "Open",
      openwaterdiver: "Open",
      ow: "Open",
      owd: "Open",
      advancedopenwater: "Advanced",
      advancedopenwaterdiver: "Advanced",
      aow: "Advanced",
      aowd: "Advanced",
      rescuediver: "Rescue",
      discoverscubadiving: "DSD",
      discoverscuba: "DSD",
      refresher: "Reactivate",
      specialty: "SpecialtyAndDistinctive",
      speciality: "SpecialtyAndDistinctive",
      distinctive: "SpecialtyAndDistinctive",
      specialtydistinctive: "SpecialtyAndDistinctive",
    },
  ),
  units: def<Units>(["Metric", "Imperial"], { Metric: "Metric", Imperial: "Imperial" }, { si: "Metric", us: "Imperial" }),
} as const;

export type EnumKind = keyof typeof ENUMS;
export type EnumValue<K extends EnumKind> = (typeof ENUMS)[K]["values"][number];

const lookups = new Map<EnumKind, Map<string, string | null>>();

function lookup(kind: EnumKind): Map<string, string | null> {
  let map = lookups.get(kind);
  if (!map) {
    const d = ENUMS[kind] as EnumDef<string>;
    map = new Map<string, string | null>();
    for (const [alias, value] of Object.entries(d.aliases)) map.set(enumKey(alias), value);
    for (const value of d.values) {
      map.set(enumKey(value), value);
      map.set(enumKey(d.labels[value]!), value);
    }
    lookups.set(kind, map);
  }
  return map;
}

/**
 * The PADI value of a lenient input. Returns null for an input that means "no value" (such as
 * "none" for surge) and undefined for an input that is not known.
 */
export function parseEnum<K extends EnumKind>(kind: K, input: string): EnumValue<K> | null | undefined {
  const key = enumKey(input);
  if (!key) return undefined;
  const map = lookup(kind);
  return map.has(key) ? (map.get(key) as EnumValue<K> | null) : undefined;
}

/** True when `value` is exactly a PADI value of the enum. */
export function isEnumValue<K extends EnumKind>(kind: K, value: unknown): value is EnumValue<K> {
  return typeof value === "string" && (ENUMS[kind].values as readonly string[]).includes(value);
}

/** The human label of a value (the value itself when it is not known). */
export function enumLabel(kind: EnumKind, value: string): string {
  const labels = ENUMS[kind].labels as Readonly<Record<string, string>>;
  return labels[value] ?? value;
}

/** "Boat, BeachShore (Shore), Other": the accepted values for descriptions and errors. */
export function describeEnum(kind: EnumKind): string {
  const d = ENUMS[kind] as EnumDef<string>;
  return d.values.map((v) => (enumKey(d.labels[v]!) === enumKey(v) ? v : `${v} (${d.labels[v]})`)).join(", ");
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export const LOCKED_STATUSES: readonly LockedStatus[] = ["Pending", "Verified", "QR Code Verified"];

/** Pending, Verified and QR Code Verified dives cannot be changed or deleted. */
export function isLockedStatus(status: string | null | undefined): boolean {
  return !!status && (LOCKED_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------------------------

export interface GasPercentages {
  oxygen: number;
  nitrogen: number;
  helium: number;
}

/** Fixed mixes: the PADI web app fills these percentages. The others are entered by hand. */
export const GAS_PRESETS: Readonly<Partial<Record<GasMixture, GasPercentages>>> = Object.freeze({
  Air: { oxygen: 21, nitrogen: 79, helium: 0 },
  Enriched_32: { oxygen: 32, nitrogen: 68, helium: 0 },
  Enriched_36: { oxygen: 36, nitrogen: 64, helium: 0 },
  Enriched_40: { oxygen: 40, nitrogen: 60, helium: 0 },
});

// ---------------------------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------------------------

/** The extra equipment the PADI web app offers. Other free text is accepted too. */
export const EQUIPMENT_ITEMS = ["Hood", "Gloves", "Boots"] as const;

/** The PADI spelling of a known item ("hoods" -> "Hood"), or the trimmed input. */
export function canonicalEquipment(item: string): string {
  const key = enumKey(item).replace(/s$/, "");
  const known = EQUIPMENT_ITEMS.find((e) => enumKey(e).replace(/s$/, "") === key);
  return known ?? item.trim();
}

// ---------------------------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------------------------

/** Log numbers and titles of each course. Specialty dives have no number and a free title. */
export const TRAINING_DIVES: Readonly<Record<TrainingCourse, ReadonlyArray<{ log_number: number; title: string }>>> = Object.freeze({
  Open: [1, 2, 3, 4].map((n) => ({ log_number: n, title: `Open Water Training Dive ${n}` })),
  Advanced: [
    { log_number: 5, title: "Adventure Dive - Deep" },
    { log_number: 6, title: "Adventure Dive - Navigation" },
    { log_number: 7, title: "Adventure Elective Dive 1" },
    { log_number: 8, title: "Adventure Elective Dive 2" },
    { log_number: 9, title: "Adventure Elective Dive 3" },
  ],
  Rescue: [
    { log_number: 10, title: "Open Water Rescue Scenario 1" },
    { log_number: 11, title: "Open Water Rescue Scenario 2" },
  ],
  DSD: [{ log_number: 12, title: "Discover Scuba Diving" }],
  Reactivate: [{ log_number: 13, title: "ReActivate" }],
  SpecialtyAndDistinctive: [],
});

/** The training dive with this course and number, if PADI has one. */
export function trainingDive(course: TrainingCourse, logNumber: number): { log_number: number; title: string } | undefined {
  return TRAINING_DIVES[course].find((d) => d.log_number === logNumber);
}

/** Advanced Open Water elective dives (log numbers 7-9) need one of these. */
export const ADVENTURE_DIVES = [
  "Deep Diving",
  "Underwater Navigation",
  "Altitude Diving",
  "Boat Diving",
  "Digital Underwater Imaging",
  "Drift Diving",
  "Dry Suit Diving",
  "Fish Identification",
  "Night Diving",
  "Peak Performance Buoyancy",
  "Search and Recovery",
  "Rescue",
  "Underwater Naturalist",
  "Wreck Diving",
  "Adaptive Support Diver",
  "Cavern Diving",
  "Delayed Surface Marker Buoy Dive",
  "Dive Against Debris Diver (AWARE)",
  "Diver Propulsion Vehicle (DPV)",
  "Enriched Air Diver",
  "Full Face Mask Diver",
  "Ice Diver",
  "Rebreather Diver",
  "Self-Reliant Diver",
  "Shark Conservation Dive(AWARE)",
  "Sidemount Diver",
] as const;

export const ADVENTURE_ELECTIVE_NUMBERS: readonly number[] = [7, 8, 9];

/** The exact PADI spelling of an adventure dive ("night" -> "Night Diving"), or undefined. */
export function parseAdventureDive(input: string): string | undefined {
  const key = enumKey(input);
  if (!key) return undefined;
  const exact = ADVENTURE_DIVES.find((a) => enumKey(a) === key);
  if (exact) return exact;
  const matches = ADVENTURE_DIVES.filter((a) => enumKey(a).startsWith(key) || enumKey(a).replace(/(diving|diver|dive)$/, "") === key);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * "Flexible skills" of Open Water dives (the only course whose PADI form offers them). The first
 * one, "no skills", says that no flexible skill was done on the dive.
 */
export const FLEXIBLE_SKILLS = [
  "no skills",
  "cramp removal",
  "snorkel exchange",
  "tube deployment",
  "weight drop",
  "swim compass",
  "diver tow",
  "remove scuba",
  "remove weights",
] as const;

/** Extra flexible skills, offered for Open Water dives 2, 3 and 4 (not dive 1). */
export const LATER_SKILLS = ["controlled ascent", "compass navigation"] as const;

/** Rescue Diver exercises (the only skills a Rescue dive offers). */
export const RESCUE_EXERCISES = [
  "tired diver",
  "panicked diver",
  "responsive diver",
  "distressed diver underwater",
  "missing diver",
  "surfacing the unresponsive diver",
  "unresponsive diver at the surface",
  "exiting the unresponsive diver",
  "first aid for pressure",
  "unresponsive diver",
] as const;

/**
 * ReActivate requirements (the only skills a ReActivate dive offers). These are PADI's stored
 * values: "panicked diver" is the value of the "buoyancy / weight check" item.
 */
export const REACTIVATE_REQUIREMENTS = ["mask flood", "panicked diver", "weight drop", "alternate air", "log dive"] as const;

/** The labels of the PADI form that differ from the stored value, by course (label -> value). */
const SKILL_LABELS: Partial<Record<TrainingCourse, Record<string, string>>> = {
  Reactivate: { "buoyancy/weight check": "panicked diver", "buoyancy check": "panicked diver", "weight check": "panicked diver" },
};

/** The stored value of a skill for a course: a known value or form label in PADI's spelling, else undefined. */
export function canonicalSkill(course: TrainingCourse, logNumber: number | null | undefined, input: string): string | undefined {
  const key = enumKey(input);
  const known = allowedSkills(course, logNumber).find((value) => enumKey(value) === key);
  if (known) return known;
  const labels = SKILL_LABELS[course] ?? {};
  const label = Object.keys(labels).find((l) => enumKey(l) === key);
  return label ? labels[label] : undefined;
}

/** Courses whose dives store chosen skills (at least one is needed before verification). */
export const SKILL_COURSES: readonly TrainingCourse[] = ["Open", "Rescue", "Reactivate"];

/**
 * The skills a training dive may store, as the PADI web form offers them (Specialty: one
 * free-text entry, not listed here): Open Water the flexible skills, Rescue the exercises,
 * ReActivate the requirements.
 */
export function allowedSkills(course: TrainingCourse, logNumber: number | null | undefined): readonly string[] {
  switch (course) {
    case "Open":
      return logNumber === 1 ? [...FLEXIBLE_SKILLS] : [...FLEXIBLE_SKILLS, ...LATER_SKILLS];
    case "Rescue":
      return [...RESCUE_EXERCISES];
    case "Reactivate":
      return [...REACTIVATE_REQUIREMENTS];
    default:
      return [];
  }
}
