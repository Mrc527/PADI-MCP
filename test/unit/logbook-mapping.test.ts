import { describe, expect, it } from "vitest";
import {
  applyPatch,
  buildInsert,
  buildUpdate,
  decodePgArray,
  diveWebUrl,
  emptyState,
  encodePgArray,
  fromWireDate,
  missingChildren,
  stateFromWire,
  toDive,
  toDiveSummary,
  toWireDate,
  utcTimestamp,
} from "../../src/logbook/mapping.js";
import type { WireLog } from "../../src/logbook/types.js";

// Invented data only.
function wireDive(overrides: Partial<WireLog> = {}): WireLog {
  return {
    id: 501,
    log_type: "Recreational",
    log_course: null,
    log_number: null,
    dive_type: "BeachShore",
    dive_title: "House Reef ",
    dive_date: "2025-08-14T00:00:00",
    dive_location: "Coral Bay",
    memsys_member_number: null,
    status: "Publish",
    adventure_dive: "Night Diving",
    depth_times: [{ max_depth: "18.5", bottom_time: 47, time_in: null, time_out: null }],
    skills: [],
    conditions: [
      {
        water_type: "Salt",
        body_of_water: "Ocean",
        weather: "Partly Cloudy",
        air_temp: 30,
        surface_water_temp: "28.000",
        bottom_water_temp: 26,
        visibility: "High",
        visibility_distance: 20,
        wave_condition: "SmallWaves",
        current: "SomeCurrent",
        surge: null,
      },
    ],
    equipment: [
      {
        suit_type: "Shorty",
        weight: 4,
        weight_type: "Good",
        additional_equipment: ["Hood", "Boots"],
        cylinder_type: "Aluminum",
        cylinder_size: 11.1,
        gas_mixture: "Enriched_32",
        oxygen: 32,
        nitrogen: 68,
        helium: 0,
        starting_pressure: 200,
        ending_pressure: 60,
      },
    ],
    experiences: [{ feeling: "Amazing", notes: "Turtle at 12 m", buddies: "Sam Example", dive_center: "Example Divers" }],
    ...overrides,
  };
}

describe("Postgres array literals", () => {
  it("encodes items, quoting the ones that need it", () => {
    expect(encodePgArray(["Hood", "Gloves"])).toBe("{Hood,Gloves}");
    expect(encodePgArray(["no skills"])).toBe('{"no skills"}');
    expect(encodePgArray(['say "hi"', "a,b", "back\\slash", "{x}", "NULL", ""])).toBe('{"say \\"hi\\"","a,b","back\\\\slash","{x}","NULL",""}');
    expect(encodePgArray([])).toBe("{}");
    expect(encodePgArray(null)).toBeNull();
    expect(encodePgArray(undefined)).toBeNull();
  });

  it("decodes JSON arrays and array literal strings", () => {
    expect(decodePgArray(["Hood", "Boots"])).toEqual(["Hood", "Boots"]);
    expect(decodePgArray("{Hood,Gloves}")).toEqual(["Hood", "Gloves"]);
    expect(decodePgArray('{"no skills","swim compass"}')).toEqual(["no skills", "swim compass"]);
    expect(decodePgArray('{"say \\"hi\\"","a,b",NULL, plain }')).toEqual(['say "hi"', "a,b", "plain"]);
    expect(decodePgArray("{}")).toEqual([]);
    expect(decodePgArray(null)).toEqual([]);
  });

  it("round-trips any list", () => {
    const items = ["Hood", "Dive light", 'Quote "x"', "comma, here", "back\\slash", "{brace}", "null", ""];
    expect(decodePgArray(encodePgArray(items))).toEqual(items);
  });
});

describe("dates", () => {
  it("writes MM/DD/YYYY and reads the date part only", () => {
    expect(toWireDate("2026-03-21")).toBe("03/21/2026");
    expect(() => toWireDate("21.03.2026")).toThrow();
    expect(fromWireDate("2026-03-21T00:00:00")).toBe("2026-03-21");
    expect(fromWireDate("2025-04-15T21:24:43")).toBe("2025-04-15");
    expect(fromWireDate("2025-04-15")).toBe("2025-04-15");
    expect(fromWireDate("4/5/2025")).toBe("2025-04-05");
    expect(fromWireDate(null)).toBe("");
    expect(fromWireDate("garbage")).toBe("");
  });

  it("writes UTC timestamps without a zone", () => {
    expect(utcTimestamp(new Date("2026-11-09T19:40:00.123Z"))).toBe("2026-11-09T19:40:00");
  });
});

describe("wire to domain", () => {
  it("builds a summary with the locked flag and units", () => {
    const s = toDiveSummary(wireDive({ status: "Verified" }), "metric");
    expect(s).toEqual({
      id: 501,
      title: "House Reef",
      date: "2025-08-14",
      location: "Coral Bay",
      type: "Recreational",
      status: "Verified",
      dive_type: "BeachShore",
      max_depth: 18.5,
      bottom_time_min: 47,
      locked: true,
    });
    expect(toDiveSummary(wireDive({ status: "Resubmit" }), "metric").locked).toBe(false);
    expect(toDiveSummary(wireDive(), "imperial").max_depth).toBe(60.7);
  });

  it("builds a full dive in the requested units", () => {
    const d = toDive(wireDive(), "imperial");
    expect(d.units).toEqual({ depth: "ft", temp: "F", pressure: "psi", weight: "lb", volume: "cuft" });
    expect(d.air_temp).toBe(86);
    expect(d.surface_water_temp).toBe(82.4);
    expect(d.start_pressure).toBe(2901);
    expect(d.pressure_used).toBe(2031);
    expect(d.equipment).toEqual(["Hood", "Boots"]);
    expect(d.web_url).toBe("https://learning.padi.com/logbook/log-dive/recreational/update/501");
    const m = toDive(wireDive(), "metric");
    expect(m.pressure_used).toBe(140);
    expect(m.gas).toBe("Enriched_32");
    expect(m.oxygen_pct).toBe(32);
    expect(m.buddies).toBe("Sam Example");
    expect(m.adventure_dive).toBe("Night Diving");
    expect(m).not.toHaveProperty("surge");
    expect(m).not.toHaveProperty("skills");
  });

  it("copes with missing child rows and training dives", () => {
    const d = toDive(
      wireDive({
        id: 7,
        log_type: "Training",
        log_course: "Open",
        log_number: 2,
        memsys_member_number: 123456,
        depth_times: [],
        conditions: [],
        equipment: [],
        experiences: [],
        skills: [{ dive_skills: ["swim compass"] }],
      }),
      "metric",
    );
    expect(d.course).toBe("Open");
    expect(d.log_number).toBe(2);
    expect(d.instructor_number).toBe("123456");
    expect(d.skills).toEqual(["swim compass"]);
    expect(d).not.toHaveProperty("max_depth");
    expect(d.web_url).toBe(diveWebUrl(7, "Training"));
    expect(d.web_url).toContain("/training/update/7");
  });
});

describe("domain to wire", () => {
  it("builds the nested insert payload", () => {
    const s = applyPatch(emptyState(), {
      title: "Reef",
      date: "2026-11-01",
      location: "Blue Hole",
      dive_type: "Boat",
      max_depth: 28,
      bottom_time_min: 42,
      equipment: ["Hood", "Gloves"],
      gas: "Air",
    });
    const p = buildInsert(s, new Date("2026-11-09T19:40:00Z"));
    expect(p).toMatchObject({
      log_type: "Recreational",
      log_course: null,
      log_number: null,
      created_date: "2026-11-09T19:40:00",
      update_date: "2026-11-09T19:40:00",
      dive_type: "Boat",
      dive_title: "Reef",
      dive_date: "11/01/2026",
      status: "Publish",
      memsys_member_number: null,
      depth_times: { data: { max_depth: 28, bottom_time: 42 } },
      equipment: { data: { additional_equipment: "{Hood,Gloves}", gas_mixture: "Air", oxygen: 21, nitrogen: 79, helium: 0 } },
    });
    expect(p).not.toHaveProperty("skills");
    expect(p).not.toHaveProperty("affiliate_id");
    expect(p.depth_times.data).not.toHaveProperty("time_in");
  });

  it("merges a change and rewrites whole child rows (never log_type)", () => {
    const existing = wireDive();
    const s = applyPatch(stateFromWire(existing), { notes: "Changed", surge: null, max_depth: 20, gas: "Air" });
    const u = buildUpdate(existing, s, new Date("2026-11-09T10:00:00Z"));
    expect(u.id).toBe(501);
    expect(u.general).not.toHaveProperty("log_type");
    expect(u.general).not.toHaveProperty("created_date");
    expect(u.general).toMatchObject({ dive_date: "08/14/2025", update_date: "2026-11-09T10:00:00", adventure_dive: "Night Diving", status: "Publish" });
    expect(u.depthTime).toEqual({ max_depth: 20, bottom_time: 47 });
    expect(Object.keys(u.conditions)).toHaveLength(11);
    expect(u.conditions).toMatchObject({ water_type: "Salt", surface_water_temp: 28, current: "SomeCurrent", surge: null });
    expect(Object.keys(u.equipment)).toHaveLength(12);
    expect(u.equipment).toMatchObject({ additional_equipment: "{Hood,Boots}", gas_mixture: "Air", oxygen: 21, nitrogen: 79, helium: 0 });
    expect(u.experience).toEqual({ feeling: "Amazing", notes: "Changed", buddies: "Sam Example", dive_center: "Example Divers" });
    expect(u).not.toHaveProperty("skills");
    expect(u.missing).toBeUndefined();
  });

  it("lists missing child rows to insert", () => {
    const existing = wireDive({ conditions: [], experiences: undefined });
    expect(missingChildren(existing)).toEqual(["conditions", "experiences", "skills"]);
    const u = buildUpdate(existing, stateFromWire(existing));
    expect(u.missing).toEqual(["conditions", "experiences"]);
    const withSkills = buildUpdate(existing, stateFromWire(existing), new Date(), { withSkills: true });
    expect(withSkills.missing).toEqual(["conditions", "experiences", "skills"]);
    expect(withSkills.skills).toEqual({ dive_skills: null });
  });

  it("clearing the gas clears the percentages", () => {
    const s = applyPatch(stateFromWire(wireDive()), { gas: null });
    expect([s.gas, s.oxygen_pct, s.nitrogen_pct, s.helium_pct]).toEqual([null, null, null, null]);
  });

  it("writes the instructor number as a number and keeps time_in only when asked", () => {
    const existing = wireDive({ depth_times: [{ max_depth: 10, bottom_time: 30, time_in: "09:00", time_out: null }] });
    const s = { ...stateFromWire(existing), instructor_number: "123456", status: "Pending" };
    const u = buildUpdate(existing, s);
    expect(u.general.memsys_member_number).toBe(123456);
    expect(u.depthTime).toEqual({ max_depth: 10, bottom_time: 30 });
    expect(buildUpdate(existing, s, new Date(), { withTimes: true }).depthTime).toEqual({ max_depth: 10, bottom_time: 30, time_in: "09:00", time_out: null });
  });
});
