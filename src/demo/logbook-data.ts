/**
 * The sample logbook of the demo accounts. Every name, number, site, dive center and e-mail here
 * is invented: no real person, PADI Pro or PADI account is behind them.
 *
 * The dives cover about three years before the day of the reset: an Open Water course (training
 * dives 1-4), an Advanced course (dives 5 and 6), holidays on invented reefs and local lake and
 * quarry dives. Most dives are "Publish", the training dives and a few others are "Verified" by
 * the invented PADI Pro below, one dive waits for verification ("Pending") and the newest one is a
 * "Draft". The rows have the shape PADI returns (wire level): values in metric units, dates as
 * naive date-times, children as arrays.
 */

import type {
  BodyOfWater,
  Certification,
  Current,
  DiveSite,
  DiveStatus,
  DiveType,
  Feeling,
  GasMixture,
  SuitType,
  Surge,
  TrainingCourse,
  Visibility,
  WaterType,
  WaveCondition,
  Weather,
  WeightType,
  CylinderType,
  WireLog,
} from "../logbook/types.js";
import { addDays, todayInZone } from "../util/dates.js";

/** The demo diver's name (invented). */
export const DEMO_NAME = "Alex Demo";
/** The demo diver's e-mail (invented; the example.com domain never receives mail). */
export const DEMO_ADDRESS = "alex.demo@example.com";
/** The demo diver's PADI affiliate id (invented). */
export const DEMO_AFFILIATE_ID = "10000001";
/** The member number of the invented PADI Pro who verifies the demo dives. */
export const DEMO_INSTRUCTOR_NUMBER = "900001";
/** The invented PADI Pros the demo instructor lookup knows. */
export const DEMO_INSTRUCTORS: ReadonlyArray<{ memberNumber: number; firstName: string; middleInitial: string; lastName: string }> = [
  { memberNumber: 900001, firstName: "Robin", middleInitial: "", lastName: "Example" },
  { memberNumber: 900002, firstName: "Kai", middleInitial: "J", lastName: "Sample" },
];

/** The invented dive site list (logbook_dive_site). */
export const DEMO_SITES: readonly DiveSite[] = [
  "Anchor Rock",
  "Blue Lantern Bay",
  "Copper Quarry",
  "Coral Garden South",
  "Eel Garden",
  "Ferry Wreck of Port Ardent",
  "Hidden Arch",
  "Kelp Cathedral",
  "Lake Serein",
  "Lantern Reef",
  "Lumen Bay House Reef",
  "Manta Station Rock",
  "Mantis Point",
  "Old Lighthouse Wall",
  "Pelican Pinnacle",
  "Sandy Slope",
  "Seagrass Meadow",
  "Turtle Terrace",
  "Whispering Drop-off",
].map((name, i) => ({ id: 5001 + i, name }));

/** The first id of the sample dives. New dives get higher ids, as on PADI. */
const FIRST_ID = 41_000_101;

interface Conditions {
  water: WaterType;
  body: BodyOfWater;
  weather: Weather;
  air: number | null;
  surface: number | null;
  bottom: number | null;
  vis: Visibility;
  visM: number | null;
  waves: WaveCondition;
  current: Current;
  surge: Surge | null;
}

interface Equipment {
  suit: SuitType;
  weight: number;
  weightType: WeightType;
  extra: string[];
  cylinder: CylinderType;
  size: number;
  gas: GasMixture;
  /** O2, N2, He in %. Default: the preset of the gas. */
  mix?: [number, number, number];
  start: number;
  end: number;
}

interface SampleDive {
  /** Days before the reset day. */
  daysAgo: number;
  /** A time of day on dive_date: older dives logged with a phone app carry one. */
  clock?: string;
  title: string;
  location: string;
  diveType: DiveType;
  status: DiveStatus;
  training?: { course: TrainingCourse; number: number; skills?: string[] };
  /** Recreational dives logged by an older app have log_number 0 instead of null. */
  logNumberZero?: boolean;
  adventure?: string;
  /** Sent to (or verified by) the demo PADI Pro. */
  pro?: boolean;
  depth: number | null;
  minutes: number | null;
  cond: Conditions;
  equip: Equipment;
  feeling: Feeling | null;
  notes: string;
  buddies: string;
  center: string;
}

const GAS_PRESETS: Partial<Record<GasMixture, [number, number, number]>> = {
  Air: [21, 79, 0],
  Enriched_32: [32, 68, 0],
  Enriched_36: [36, 64, 0],
  Enriched_40: [40, 60, 0],
};

// Short-hands for the conditions of the places the demo diver dives at.
const quarry = (o: Partial<Conditions> = {}): Conditions => ({
  water: "Fresh", body: "Quarry", weather: "Sunny", air: 22, surface: 18, bottom: 9, vis: "Average", visM: 8,
  waves: "NoWaves", current: "NoCurrent", surge: null, ...o,
});
const lake = (o: Partial<Conditions> = {}): Conditions => ({
  water: "Fresh", body: "Lake", weather: "Cloudy", air: 15, surface: 14, bottom: 7, vis: "Average", visM: 6,
  waves: "NoWaves", current: "NoCurrent", surge: null, ...o,
});
const sea = (o: Partial<Conditions> = {}): Conditions => ({
  water: "Salt", body: "Ocean", weather: "Sunny", air: 30, surface: 28, bottom: 26, vis: "High", visM: 25,
  waves: "SmallWaves", current: "SomeCurrent", surge: null, ...o,
});
const coldGear = (o: Partial<Equipment> = {}): Equipment => ({
  suit: "FullSuit_7mm", weight: 10, weightType: "Good", extra: ["Hood", "Gloves", "Boots"], cylinder: "Steel", size: 12,
  gas: "Air", start: 200, end: 70, ...o,
});
const warmGear = (o: Partial<Equipment> = {}): Equipment => ({
  suit: "FullSuit_3mm", weight: 4, weightType: "Good", extra: [], cylinder: "Aluminum", size: 11.1, gas: "Air",
  start: 200, end: 60, ...o,
});

const SCHOOL = "Copper Quarry Dive School";
const HOLIDAY_CENTER = "Lantern Reef Divers";
const ARDENT = "Port Ardent Dive Club";

/** The sample dives, oldest first. */
const SAMPLE_DIVES: readonly SampleDive[] = [
  {
    daysAgo: 1065, title: "Open Water Training Dive 1", location: "Copper Quarry", diveType: "BeachShore", status: "Verified",
    training: { course: "Open", number: 1, skills: ["no skills"] }, pro: true, depth: 6.2, minutes: 38,
    cond: quarry(), equip: coldGear({ weight: 12, weightType: "Heavy", start: 200, end: 110 }), feeling: "Good",
    notes: "First open water dive. Mask clearing went fine.", buddies: "Sam Example", center: SCHOOL,
  },
  {
    daysAgo: 1065, title: "Open Water Training Dive 2", location: "Copper Quarry", diveType: "BeachShore", status: "Verified",
    training: { course: "Open", number: 2, skills: ["cramp removal", "snorkel exchange"] }, pro: true, depth: 9.4, minutes: 41,
    cond: quarry({ weather: "Partly Cloudy" }), equip: coldGear({ weight: 12, start: 210, end: 100 }), feeling: "Good",
    notes: "", buddies: "Sam Example", center: SCHOOL,
  },
  {
    daysAgo: 1064, title: "Open Water Training Dive 3", location: "Lake Serein", diveType: "BeachShore", status: "Verified",
    training: { course: "Open", number: 3, skills: ["weight drop", "controlled ascent"] }, pro: true, depth: 12, minutes: 39,
    cond: lake(), equip: coldGear({ weight: 11 }), feeling: "Average",
    notes: "Cold at the bottom. Practised the controlled ascent.", buddies: "Sam Example", center: SCHOOL,
  },
  {
    daysAgo: 1064, title: "Open Water Training Dive 4", location: "Lake Serein", diveType: "BeachShore", status: "Verified",
    training: { course: "Open", number: 4, skills: ["swim compass", "compass navigation"] }, pro: true, depth: 16.5, minutes: 36,
    cond: lake({ weather: "Rainy", vis: "Low", visM: 4 }), equip: coldGear({ weight: 11, start: 200, end: 80 }), feeling: "Amazing",
    notes: "Last training dive. Certified!", buddies: "Sam Example", center: SCHOOL,
  },
  {
    daysAgo: 905, clock: "08:33:08", title: "First reef dive", location: "Lantern Reef", diveType: "Boat", status: "Publish",
    logNumberZero: true, depth: 12.3, minutes: 48, cond: sea(), equip: warmGear({ suit: "Shorty", weight: 5 }), feeling: "Amazing",
    notes: "So many colours. A school of yellow snappers under the boat.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 904, title: "Turtles everywhere", location: "Turtle Terrace", diveType: "Boat", status: "Publish",
    depth: 14.8, minutes: 52, cond: sea({ weather: "Partly Cloudy" }), equip: warmGear({ suit: "Shorty", weight: 5 }), feeling: "Amazing",
    notes: "Three green turtles resting on the terrace.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 903, clock: "17:42:10", title: "Mantis shrimp hunt", location: "Mantis Point", diveType: "BeachShore", status: "Publish",
    adventure: "Fish Identification", depth: 9.1, minutes: 61, cond: sea({ current: "NoCurrent", visM: 18 }),
    equip: warmGear({ suit: "Shorty", weight: 4 }), feeling: "Good",
    notes: "Found two peacock mantis shrimps near the sandy slope.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 902, title: "Drift along the wall", location: "Old Lighthouse Wall", diveType: "Boat", status: "Verified",
    pro: true, depth: 18, minutes: 44, cond: sea({ current: "StrongCurrent", waves: "MediumWaves", weather: "Windy" }),
    equip: warmGear({ weight: 5, end: 50 }), feeling: "Good",
    notes: "Fast drift. Stayed close to the guide.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 702, title: "Adventure Dive - Deep", location: "Whispering Drop-off", diveType: "Boat", status: "Verified",
    training: { course: "Advanced", number: 5 }, pro: true, depth: 29.6, minutes: 32, cond: sea({ bottom: 24 }),
    equip: warmGear({ weight: 5, end: 70 }), feeling: "Good",
    notes: "Colours fade at depth. The red tile looked brown at 29 m.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 702, title: "Adventure Dive - Navigation", location: "Hidden Arch", diveType: "BeachShore", status: "Verified",
    training: { course: "Advanced", number: 6 }, pro: true, depth: 11.2, minutes: 47, cond: sea({ current: "NoCurrent" }),
    equip: warmGear({ weight: 5 }), feeling: "Good",
    notes: "Square pattern with the compass, came back to the anchor line.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 700, title: "Night on the house reef", location: "Lumen Bay House Reef", diveType: "BeachShore", status: "Publish",
    depth: 8.7, minutes: 55, cond: sea({ weather: "Cloudy", air: 26, vis: "Average", visM: 12, current: "NoCurrent" }),
    equip: warmGear({ weight: 5, extra: ["Dive Light"] }), feeling: "Amazing",
    notes: "Night dive. A sleeping parrotfish and two cuttlefish.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 699, title: "Ferry wreck", location: "Ferry Wreck of Port Ardent", diveType: "Boat", status: "Verified",
    pro: true, depth: 27.4, minutes: 38, cond: sea({ current: "MediumCurrent", vis: "Average", visM: 15 }),
    equip: warmGear({ weight: 5, gas: "Enriched_32", end: 80 }), feeling: "Amazing",
    notes: "Swam along the car deck. Big grouper in the engine room.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 540, title: "Cold and clear", location: "Lake Serein", diveType: "BeachShore", status: "Publish",
    depth: 21, minutes: 34, cond: lake({ weather: "Sunny", air: 4, surface: 6, bottom: 5, vis: "High", visM: 15 }),
    equip: coldGear({ suit: "DrySuit", weight: 14, weightType: "Heavy" }), feeling: "Good",
    notes: "Winter dive. Very clear water.", buddies: "Sam Example", center: "",
  },
  {
    daysAgo: 470, title: "Quarry refresher", location: "Copper Quarry", diveType: "BeachShore", status: "Publish",
    depth: 14.5, minutes: 42, cond: quarry({ weather: "Foggy", air: 12, surface: 12 }), equip: coldGear({ suit: "SemiDrySuit", weight: 11 }),
    feeling: "Average", notes: "", buddies: "Sam Example", center: SCHOOL,
  },
  {
    daysAgo: 410, title: "Kelp forest", location: "Kelp Cathedral", diveType: "Boat", status: "Publish",
    depth: 16.3, minutes: 49, cond: sea({ air: 19, surface: 15, bottom: 12, vis: "Average", visM: 10, surge: "MediumSurge", waves: "MediumWaves" }),
    equip: coldGear({ weight: 12, extra: ["Hood", "Gloves"] }), feeling: "Good",
    notes: "Light rays through the kelp. Strong surge near the rocks.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 252, title: "Deep pinnacle", location: "Pelican Pinnacle", diveType: "Boat", status: "Verified",
    pro: true, depth: 38.2, minutes: 24, cond: sea({ bottom: 22, current: "MediumCurrent" }),
    equip: warmGear({ cylinder: "Steel", size: 12, weight: 3, start: 220, end: 90 }), feeling: "Good",
    notes: "Planned deep dive on air. Long safety stop.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 251, title: "Manta cleaning station", location: "Manta Station Rock", diveType: "Boat", status: "Publish",
    depth: 22.5, minutes: 51, cond: sea({ weather: "Partly Cloudy" }), equip: warmGear({ weight: 4, gas: "Enriched_32" }),
    feeling: "Amazing", notes: "Two mantas circled the bommie for twenty minutes.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 250, title: "Sunset in the seagrass", location: "Seagrass Meadow", diveType: "BeachShore", status: "Publish",
    depth: 7.5, minutes: 63, cond: sea({ current: "NoCurrent", waves: "NoWaves" }), equip: warmGear({ suit: "Shorty", weight: 4, gas: "Enriched_36" }),
    feeling: "Good", notes: "Seahorse in the seagrass.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 249, title: "Gorgonian wall", location: "Old Lighthouse Wall", diveType: "Boat", status: "Publish",
    depth: 31, minutes: 37, cond: sea({ current: "SomeCurrent" }), equip: warmGear({ weight: 4, gas: "Enriched_32", end: 70 }),
    feeling: "Amazing", notes: "Huge sea fans below 25 m.", buddies: "Kim Demo", center: HOLIDAY_CENTER,
  },
  {
    daysAgo: 120, title: "Lake dive with friends", location: "Lake Serein", diveType: "BeachShore", status: "Publish",
    depth: 18.6, minutes: 40, cond: lake({ weather: "Partly Cloudy", air: 18, surface: 17 }), equip: coldGear({ suit: "DrySuit", weight: 13 }),
    feeling: "Good", notes: "", buddies: "Sam Example, Kim Demo", center: "",
  },
  {
    daysAgo: 60, title: "Quarry photo dive", location: "Copper Quarry", diveType: "BeachShore", status: "Publish",
    depth: 11.9, minutes: 58, cond: quarry({ vis: "High", visM: 12 }), equip: coldGear({ weight: 10, extra: ["Hood", "Gloves", "Camera"] }),
    feeling: "Good", notes: "Practised photos of the old crane at 10 m.", buddies: "Sam Example", center: SCHOOL,
  },
  {
    daysAgo: 33, title: "Weekend boat dive", location: "Kelp Cathedral", diveType: "Boat", status: "Publish",
    depth: 19.4, minutes: 45, cond: sea({ weather: "Cloudy", air: 17, surface: 15, bottom: 13, vis: "Low", visM: 6, surge: "SomeSurge" }),
    equip: coldGear({ weight: 12 }), feeling: "Average", notes: "Poor visibility after the storm.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 33, title: "Second dive of the weekend", location: "Hidden Arch", diveType: "Boat", status: "Pending",
    pro: true, depth: 13.2, minutes: 52, cond: sea({ weather: "Sunny", air: 19, surface: 16, bottom: 14, vis: "Average", visM: 9, surge: "BigSurge" }),
    equip: coldGear({ weight: 12, gas: "Enriched_32" }), feeling: "Good", notes: "Sent to Robin for a signature.", buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 10, title: "Morning dive", location: "Lumen Bay House Reef", diveType: "BeachShore", status: "Publish",
    depth: 15.1, minutes: 47, cond: sea({ current: "NoCurrent" }),
    equip: warmGear({ weight: 4, gas: "Enriched", mix: [34, 66, 0] }), feeling: "Amazing", notes: "Calm sea, octopus in the rubble.",
    buddies: "Kim Demo", center: ARDENT,
  },
  {
    daysAgo: 3, title: "Lake dive (to finish)", location: "Lake Serein", diveType: "BeachShore", status: "Draft",
    depth: null, minutes: null, cond: lake(), equip: coldGear({ suit: "DrySuit", weight: 13 }), feeling: null,
    notes: "Add depth and time from the computer.", buddies: "Sam Example", center: "",
  },
];

/** "YYYY-MM-DD" to the naive date-time PADI returns. */
function naive(date: string, clock = "00:00:00"): string {
  return `${date}T${clock}`;
}

function toWire(d: SampleDive, id: number, today: string): WireLog {
  const date = addDays(today, -d.daysAgo);
  const mix = d.equip.mix ?? GAS_PRESETS[d.equip.gas] ?? [0, 0, 0];
  const stamp = naive(date, "19:30:00");
  return {
    id,
    affiliate_id: Number(DEMO_AFFILIATE_ID),
    log_type: d.training ? "Training" : "Recreational",
    log_course: d.training?.course ?? null,
    log_number: d.training?.number ?? (d.logNumberZero ? 0 : null),
    dive_type: d.diveType,
    dive_title: d.title,
    dive_date: naive(date, d.clock),
    dive_location: d.location,
    memsys_member_number: d.pro ? Number(DEMO_INSTRUCTOR_NUMBER) : null,
    status: d.status,
    adventure_dive: d.adventure ?? null,
    created_date: stamp,
    update_date: stamp,
    depth_times: [{ id: id * 10 + 1, logs_id: id, max_depth: d.depth, bottom_time: d.minutes, time_in: null, time_out: null }],
    conditions: [
      {
        id: id * 10 + 2,
        logs_id: id,
        water_type: d.cond.water,
        body_of_water: d.cond.body,
        weather: d.cond.weather,
        air_temp: d.cond.air,
        surface_water_temp: d.cond.surface,
        bottom_water_temp: d.cond.bottom,
        visibility: d.cond.vis,
        visibility_distance: d.cond.visM,
        wave_condition: d.cond.waves,
        current: d.cond.current,
        surge: d.cond.surge,
      },
    ],
    equipment: [
      {
        id: id * 10 + 3,
        logs_id: id,
        suit_type: d.equip.suit,
        weight: d.equip.weight,
        weight_type: d.equip.weightType,
        additional_equipment: [...d.equip.extra],
        cylinder_type: d.equip.cylinder,
        cylinder_size: d.equip.size,
        gas_mixture: d.equip.gas,
        oxygen: mix[0],
        nitrogen: mix[1],
        helium: mix[2],
        starting_pressure: d.equip.start,
        ending_pressure: d.equip.end,
      },
    ],
    experiences: [{ id: id * 10 + 4, logs_id: id, feeling: d.feeling, notes: d.notes, buddies: d.buddies, dive_center: d.center }],
    // Open Water dives store the ticked skills; other training dives and recreational dives have no row.
    skills: d.training?.skills ? [{ id: id * 10 + 5, logs_id: id, dive_skills: [...d.training.skills] }] : [],
  };
}

/** The sample dives for a reset at `now`, dated relative to today in `timeZone`. */
export function sampleDives(now: Date, timeZone: string): WireLog[] {
  const today = todayInZone(timeZone, now);
  return SAMPLE_DIVES.map((d, i) => toWire(d, FIRST_ID + i * 13, today));
}

/** The demo diver's eCards, dated relative to today in `timeZone` (after the matching dives). */
export function sampleCertifications(now: Date, timeZone: string): Certification[] {
  const today = todayInZone(timeZone, now);
  const card = (title: string, daysAgo: number, licenseId: string, storeName: string): Certification => ({
    title,
    certDate: addDays(today, -daysAgo),
    padiNumber: "DEMO000001",
    instructorName: "Robin Example",
    instructorNumber: DEMO_INSTRUCTOR_NUMBER,
    storeName,
    licenseId,
  });
  return [
    card("Enriched Air Diver", 253, "DEMO-EAN-3", HOLIDAY_CENTER),
    card("Advanced Open Water Diver", 701, "DEMO-AOW-2", ARDENT),
    card("Open Water Diver", 1063, "DEMO-OWD-1", SCHOOL),
  ];
}
