import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as z4mini from "zod/v4-mini";
import { decodePgArray } from "../../src/logbook/mapping.js";
import {
  createDiveShape,
  csvCell,
  deleteDiveShape,
  exportShape,
  getDiveShape,
  getPhotosShape,
  listDivesShape,
  LogbookService,
  lookupInstructorShape,
  MAX_PHOTO_BYTES,
  searchSitesShape,
  setUnitsShape,
  statsShape,
  submitForVerificationShape,
  updateDiveShape,
  type CreateDiveArgs,
  type LogbookServiceOptions,
} from "../../src/logbook/service.js";
import type {
  BackendCheck,
  Certification,
  DiveSite,
  DiveStatus,
  InstructorMatch,
  ListQuery,
  LogbookBackend,
  LogType,
  PadiAccount,
  Units,
  WireLog,
  WireLogInsert,
  WireLogUpdate,
} from "../../src/logbook/types.js";
import { NotFoundError, ReadOnlyError, UserFacingError } from "../../src/util/errors.js";

// Invented data only.
const NOW = new Date("2026-11-09T12:00:00Z");

function dive(id: number, date: string, overrides: Partial<WireLog> = {}): WireLog {
  return {
    id,
    log_type: "Recreational",
    log_course: null,
    log_number: null,
    dive_type: "Boat",
    dive_title: `Dive ${id}`,
    dive_date: `${date}T00:00:00`,
    dive_location: "Example Reef",
    memsys_member_number: null,
    status: "Publish",
    adventure_dive: null,
    depth_times: [{ max_depth: 10 + id, bottom_time: 30 + id, time_in: null, time_out: null }],
    skills: [],
    conditions: [
      {
        water_type: "Salt",
        body_of_water: "Ocean",
        weather: "Sunny",
        air_temp: 25,
        surface_water_temp: 24,
        bottom_water_temp: 22,
        visibility: "High",
        visibility_distance: 15,
        wave_condition: "NoWaves",
        current: "NoCurrent",
        surge: null,
      },
    ],
    equipment: [
      {
        suit_type: "FullSuit_5mm",
        weight: 6,
        weight_type: "Good",
        additional_equipment: [],
        cylinder_type: "Steel",
        cylinder_size: 12,
        gas_mixture: "Air",
        oxygen: 21,
        nitrogen: 79,
        helium: 0,
        starting_pressure: 200,
        ending_pressure: 50,
      },
    ],
    experiences: [{ feeling: "Good", notes: "", buddies: "Kim Sample", dive_center: "Sample Divers" }],
    ...overrides,
  };
}

/** An in-memory backend that keeps wire rows and records every call. */
class FakeBackend implements LogbookBackend {
  readonly kind = "padi" as const;
  logs = new Map<number, WireLog>();
  units: Units = "Metric";
  calls: string[] = [];
  inserts: WireLogInsert[] = [];
  updates: WireLogUpdate[] = [];
  deleted: number[] = [];
  instructors: Record<string, InstructorMatch[]> = { "123456": [{ memberNumber: 123456, name: "Pat Q Instructor" }] };
  photos: Record<string, Buffer> = {};
  nextId = 1000;
  delayMs = 0;
  log: string[] = [];

  constructor(dives: WireLog[] = []) {
    for (const d of dives) this.logs.set(d.id, structuredClone(d));
  }

  private async wait(): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  async listLogs(q: ListQuery): Promise<WireLog[]> {
    this.calls.push(`listLogs:${JSON.stringify(q)}`);
    let all = [...this.logs.values()];
    if (q.logType) all = all.filter((d) => d.log_type === q.logType);
    else if (q.status) all = all.filter((d) => d.status === q.status);
    const key = q.orderBy ?? "date";
    all.sort((a, b) => {
      if (key === "max_depth") return Number(b.depth_times?.[0]?.max_depth ?? 0) - Number(a.depth_times?.[0]?.max_depth ?? 0);
      if (key === "bottom_time") return Number(b.depth_times?.[0]?.bottom_time ?? 0) - Number(a.depth_times?.[0]?.bottom_time ?? 0);
      return (b.dive_date ?? "").localeCompare(a.dive_date ?? "") || b.id - a.id;
    });
    const start = q.offset ?? 0;
    const page = q.limit === null || q.limit === undefined ? all.slice(start) : all.slice(start, start + q.limit);
    return structuredClone(page);
  }
  async countLogs(filter: { logType?: LogType; status?: DiveStatus } = {}): Promise<number> {
    this.calls.push(`countLogs:${JSON.stringify(filter)}`);
    return (await this.listLogs({ limit: null, ...filter })).length;
  }
  async totalBottomTime(): Promise<number | null> {
    return null;
  }
  async getLog(id: number): Promise<WireLog | undefined> {
    this.calls.push(`getLog:${id}`);
    const d = this.logs.get(id);
    return d ? structuredClone(d) : undefined;
  }
  async insertLog(payload: WireLogInsert): Promise<number> {
    this.calls.push("insertLog");
    this.inserts.push(structuredClone(payload));
    const id = this.nextId++;
    const p = payload;
    this.logs.set(id, {
      id,
      log_type: p.log_type,
      log_course: p.log_course,
      log_number: p.log_number,
      dive_type: p.dive_type,
      dive_title: p.dive_title,
      dive_date: p.dive_date.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2T00:00:00"),
      dive_location: p.dive_location,
      memsys_member_number: p.memsys_member_number,
      status: p.status,
      adventure_dive: p.adventure_dive ?? null,
      depth_times: [{ time_in: null, time_out: null, max_depth: null, bottom_time: null, ...p.depth_times.data }],
      conditions: [p.conditions.data as never],
      equipment: [{ ...(p.equipment.data as object), additional_equipment: decodePgArray(p.equipment.data.additional_equipment) } as never],
      experiences: [p.experiences.data as never],
      skills: p.skills ? [{ dive_skills: decodePgArray(p.skills.data.dive_skills) }] : [],
    });
    return id;
  }
  async updateLog(update: WireLogUpdate): Promise<void> {
    this.log.push(`update-start:${update.id}`);
    await this.wait();
    this.calls.push(`updateLog:${update.id}`);
    this.updates.push(structuredClone(update));
    const d = this.logs.get(update.id)!;
    const g = update.general as Record<string, unknown>;
    Object.assign(d, g, { dive_date: String(g.dive_date).replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2T00:00:00") });
    d.depth_times = [{ ...(d.depth_times?.[0] ?? { time_in: null, time_out: null }), ...(update.depthTime as object) } as never];
    d.conditions = [update.conditions as never];
    d.equipment = [{ ...(update.equipment as object), additional_equipment: decodePgArray(update.equipment.additional_equipment) } as never];
    d.experiences = [update.experience as never];
    if (update.skills) d.skills = [{ dive_skills: decodePgArray(update.skills.dive_skills) }];
    this.log.push(`update-end:${update.id}`);
  }
  async deleteLog(id: number): Promise<void> {
    this.calls.push(`deleteLog:${id}`);
    this.deleted.push(id);
    this.logs.delete(id);
  }
  async searchSites(pattern: string, limit: number): Promise<DiveSite[]> {
    this.calls.push(`searchSites:${pattern}:${limit}`);
    return [{ id: 1, name: "Example Reef" }];
  }
  async getUnits(): Promise<Units> {
    this.calls.push("getUnits");
    return this.units;
  }
  async setUnits(units: Units): Promise<void> {
    this.calls.push(`setUnits:${units}`);
    this.units = units;
  }
  async lookupInstructor(memberNumber: string): Promise<InstructorMatch[]> {
    this.calls.push(`lookupInstructor:${memberNumber}`);
    return this.instructors[memberNumber] ?? [];
  }
  async listCertifications(): Promise<Certification[]> {
    return [{ title: "Open Water Diver" }];
  }
  async listPhotoIds(logId: number): Promise<string[]> {
    this.calls.push(`listPhotoIds:${logId}`);
    return Object.keys(this.photos);
  }
  async getPhoto(_logId: number, photoId: string): Promise<{ data: Buffer; mimeType: string }> {
    return { data: this.photos[photoId]!, mimeType: "image/jpeg" };
  }
  async account(): Promise<PadiAccount> {
    return { affiliateId: "10000001", isPro: false };
  }
  async check(): Promise<BackendCheck> {
    return { ok: true, dives: this.logs.size };
  }
  async close(): Promise<void> {}
}

function service(backend: FakeBackend, opts: Partial<LogbookServiceOptions> & { clock?: () => Date } = {}) {
  const { clock, ...rest } = opts;
  return new LogbookService(backend, { readOnly: false, units: "metric", timeZone: "UTC", now: clock ?? (() => NOW), ...rest });
}

const base: CreateDiveArgs = { title: "Morning dive", date: "2026-11-01", location: "Example Reef", dive_type: "Boat", max_depth: 18, bottom_time_min: 45 };

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("input shapes", () => {
  const shapes = {
    listDivesShape,
    getDiveShape,
    statsShape,
    searchSitesShape,
    exportShape,
    lookupInstructorShape,
    getPhotosShape,
    setUnitsShape,
    submitForVerificationShape,
    deleteDiveShape,
    createDiveShape,
    updateDiveShape,
  };

  it("all convert to JSON Schema (as the MCP SDK does) and every field has a description", () => {
    for (const [name, shape] of Object.entries(shapes)) {
      const schema = z4mini.toJSONSchema(z.strictObject(shape) as never, { target: "draft-7", io: "input" }) as { properties: Record<string, { description?: string }>; additionalProperties?: boolean };
      expect(schema.additionalProperties, name).toBe(false);
      for (const [field, prop] of Object.entries(schema.properties)) {
        if (["dive_id", "units"].includes(field)) continue;
        expect(prop.description, `${name}.${field}`).toBeTruthy();
      }
    }
    const create = z4mini.toJSONSchema(z.strictObject(createDiveShape) as never, { target: "draft-7", io: "input" }) as { required: string[]; properties: Record<string, { description?: string }> };
    expect(create.required.sort()).toEqual(["date", "dive_type", "location", "title"]);
    expect(create.properties.dive_type!.description).toContain("BeachShore");
    expect(create.properties.max_depth!.description).toMatch(/m \(metric\) or ft \(imperial\)/);
  });

  it("accepts lenient enum spellings and refuses unknown ones with the allowed values", () => {
    const create = z.strictObject(createDiveShape);
    const ok = create.parse({ ...base, dive_type: "shore", surge: "none", gas: "nitrox 32", suit: "3mm", current: "light current", status: "draft" });
    expect(ok).toMatchObject({ dive_type: "BeachShore", gas: "Enriched_32", suit: "FullSuit_3mm", current: "SomeCurrent", status: "Draft" });
    expect(ok.surge).toBeUndefined();
    const bad = create.safeParse({ ...base, dive_type: "car" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("Boat, BeachShore (Shore), Other");
    expect(create.safeParse({ ...base, status: "Pending" }).success).toBe(false);
    expect(create.safeParse({ ...base, affiliate_id: 1 }).success).toBe(false);
    expect(create.safeParse({ ...base, training: { course: "Open", log_number: 2, extra: 1 } }).success).toBe(false);
    expect(create.parse({ ...base, training: { course: "open water", log_number: 2 } }).training?.course).toBe("Open");
  });

  it("lets an update clear fields with null, but not the required ones", () => {
    const update = z.strictObject(updateDiveShape);
    expect(update.parse({ dive_id: 3, surge: null, current: "strong", weather: "Partly cloudy", notes: null })).toMatchObject({
      surge: null,
      current: "StrongCurrent",
      weather: "Partly Cloudy",
      notes: null,
    });
    expect(update.parse({ dive_id: 3, surge: "none" }).surge).toBeNull();
    expect(update.safeParse({ dive_id: 3, title: null }).success).toBe(false);
    expect(update.safeParse({ dive_id: 3, dive_type: null }).success).toBe(false);
    expect(z.strictObject(submitForVerificationShape).safeParse({ dive_id: 1, instructor_number: "12", confirm: false }).success).toBe(false);
  });
});

describe("LogbookService reading", () => {
  it("lists a page from PADI with the total and the next offset", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05"), dive(2, "2026-02-05"), dive(3, "2026-03-05")]);
    const res = await service(b).listDives({ limit: 2 });
    expect(res.total).toBe(3);
    expect(res.dives.map((d) => d.id)).toEqual([3, 2]);
    expect(res.next_offset).toBe(2);
    expect(res.units.depth).toBe("m");
    expect(b.calls).toContain('listLogs:{"limit":2,"offset":0,"orderBy":"date","withDepthTime":true}');
    const last = await service(b).listDives({ limit: 2, offset: 2 });
    expect(last.dives.map((d) => d.id)).toEqual([1]);
    expect(last.next_offset).toBeUndefined();
  });

  it("filters by date and text on our side", async () => {
    const b = new FakeBackend([
      dive(1, "2025-12-30"),
      dive(2, "2026-02-05", { experiences: [{ feeling: null, notes: null, buddies: "Jordan Placeholder", dive_center: null }] }),
      dive(3, "2026-03-05", { dive_location: "Café Wall" }),
    ]);
    const s = service(b);
    expect((await s.listDives({ from: "2026-01-01" })).dives.map((d) => d.id)).toEqual([3, 2]);
    expect((await s.listDives({ to: "2026-01-01" })).total).toBe(1);
    expect((await s.listDives({ query: "jordan" })).dives.map((d) => d.id)).toEqual([2]);
    expect((await s.listDives({ query: "cafe" })).dives.map((d) => d.id)).toEqual([3]);
    await expect(s.listDives({ from: "2026-02-01", to: "2026-01-01" })).rejects.toThrow(/after/);
  });

  it("uses the PADI units setting for auto and caches it for 5 minutes", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.units = "Imperial";
    let now = NOW.getTime();
    const s = service(b, { units: "auto", clock: () => new Date(now) });
    const first = await s.getDive({ dive_id: 1 });
    expect(first.units.depth).toBe("ft");
    expect(first.max_depth).toBe(36.1);
    await s.getDive({ dive_id: 1 });
    expect(b.calls.filter((c) => c === "getUnits")).toHaveLength(1);
    now += 5 * 60_000 + 1;
    await s.getDive({ dive_id: 1 });
    expect(b.calls.filter((c) => c === "getUnits")).toHaveLength(2);
    expect((await s.getDive({ dive_id: 1, units: "metric" })).max_depth).toBe(11);
  });

  it("reports a missing dive", async () => {
    const err = await rejects(service(new FakeBackend()).getDive({ dive_id: 9 }));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("computes statistics with groups", async () => {
    const b = new FakeBackend([dive(1, "2025-06-01"), dive(2, "2026-01-05"), dive(3, "2026-02-05", { dive_location: "example reef " })]);
    const st = await service(b).stats({ group_by: "year" });
    expect(st.count).toBe(3);
    expect(st.total_bottom_time_min).toBe(31 + 32 + 33);
    expect(st.total_bottom_time).toBe("1:36");
    expect(st.deepest).toMatchObject({ dive_id: 3, max_depth: 13 });
    expect(st.longest).toMatchObject({ dive_id: 3, bottom_time_min: 33 });
    expect(st.average_max_depth).toBe(12);
    expect(st.first_dive).toBe("2025-06-01");
    expect(st.last_dive).toBe("2026-02-05");
    expect(st.groups?.map((g) => [g.key, g.count])).toEqual([
      ["2025", 1],
      ["2026", 2],
    ]);
    const byLocation = await service(b).stats({ group_by: "location", from: "2026-01-01" });
    expect(byLocation.count).toBe(2);
    expect(byLocation.groups).toHaveLength(1);
  });

  it("exports CSV with unit headers and safe cells, and JSON", async () => {
    const b = new FakeBackend([
      dive(1, "2026-01-05", { experiences: [{ feeling: "Good", notes: 'Line one\nsaid "wow", then =SUM(A1)', buddies: "=cmd", dive_center: null }] }),
      dive(2, "2025-01-05"),
    ]);
    const csv = await service(b).exportDives({ format: "csv", units: "imperial" });
    expect(csv.count).toBe(2);
    const lines = csv.content.split("\r\n");
    expect(lines[0]).toContain("max_depth_ft");
    expect(lines[0]).toContain("start_pressure_psi");
    expect(lines[1]!.startsWith("2,2025-01-05,")).toBe(true);
    expect(csv.content).toContain('"Line one\nsaid ""wow"", then =SUM(A1)"');
    expect(csv.content).toContain(",'=cmd,");
    const json = await service(b).exportDives({ format: "json", from: "2026-01-01" });
    expect(JSON.parse(json.content)).toHaveLength(1);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(["Hood", "Boots"])).toBe("Hood; Boots");
  });

  it("caps photos by size", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.photos = { a: Buffer.alloc(1000), big: Buffer.alloc(MAX_PHOTO_BYTES + 1), c: Buffer.alloc(1_400_000), d: Buffer.alloc(1_400_000), e: Buffer.alloc(1_400_000) };
    const res = await service(b).getPhotos({ dive_id: 1, max: 5 });
    expect(res.total).toBe(5);
    expect(res.photos.map((p) => p.id)).toEqual(["a", "c", "d"]);
    expect(res.skipped).toBe(2);
    const few = await service(b).getPhotos({ dive_id: 1, max: 1 });
    expect(few.photos.map((p) => p.id)).toEqual(["a"]);
    expect(few.skipped).toBe(4);
    await expect(service(b).getPhotos({ dive_id: 2 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("searches sites with the user's text escaped", async () => {
    const b = new FakeBackend();
    const res = await service(b).searchSites({ query: "100%_reef" });
    expect(res.sites).toHaveLength(1);
    expect(b.calls).toContain("searchSites:%100\\%\\_reef%:20");
  });

  it("looks up instructors and units", async () => {
    const b = new FakeBackend();
    const s = service(b, { units: "auto" });
    expect(await s.lookupInstructor("123456")).toEqual({ member_number: "123456", found: true, name: "Pat Q Instructor" });
    expect(await s.lookupInstructor("999")).toEqual({ member_number: "999", found: false });
    expect(await s.getUnits()).toEqual({ padi_setting: "Metric", effective: "metric" });
    expect(await s.setUnits("imperial")).toEqual({ padi_setting: "Imperial", effective: "imperial" });
    expect(b.calls).toContain("setUnits:Imperial");
  });
});

describe("LogbookService creating dives", () => {
  it("creates a dive in metric, filling the gas preset", async () => {
    const b = new FakeBackend();
    const d = await service(b).createDive({ ...base, gas: "Enriched_32", equipment: ["hoods", "Gloves", "hood"], notes: "  " });
    expect(d.id).toBe(1000);
    expect(d.title).toBe("Morning dive");
    expect(d.status).toBe("Publish");
    const p = b.inserts[0]!;
    expect(p.dive_date).toBe("11/01/2026");
    expect(p.created_date).toBe("2026-11-09T12:00:00");
    expect(p.equipment.data).toMatchObject({ gas_mixture: "Enriched_32", oxygen: 32, nitrogen: 68, helium: 0, additional_equipment: "{Hood,Gloves}" });
    expect(p.experiences.data.notes).toBeNull();
    expect(p).not.toHaveProperty("affiliate_id");
  });

  it("converts imperial input to metric", async () => {
    const b = new FakeBackend();
    const d = await service(b).createDive({ ...base, max_depth: 60, air_temp: 86, start_pressure: 3000, end_pressure: 700, weight: 12, units: "imperial" });
    expect(b.inserts[0]!.depth_times.data.max_depth).toBe(18.288);
    expect(b.inserts[0]!.conditions.data.air_temp).toBe(30);
    expect(b.inserts[0]!.equipment.data.starting_pressure).toBe(206.843);
    expect(d.units.depth).toBe("ft");
    expect(d.max_depth).toBe(60);
    expect(d.pressure_used).toBe(2300);
  });

  it("refuses dates in the future, using the configured time zone for today", async () => {
    const late = () => new Date("2026-11-09T23:30:00Z");
    const tomorrowUtc = { ...base, date: "2026-11-10" };
    await expect(service(new FakeBackend(), { clock: late }).createDive(tomorrowUtc)).rejects.toThrow(/in the future/);
    // In Auckland it is already 10 November.
    const d = await service(new FakeBackend(), { clock: late, timeZone: "Pacific/Auckland" }).createDive(tomorrowUtc);
    expect(d.date).toBe("2026-11-10");
    await expect(service(new FakeBackend()).createDive({ ...base, date: "1926-11-08" })).rejects.toThrow(/100 years/);
    await expect(service(new FakeBackend()).createDive({ ...base, date: "2026-02-30" })).rejects.toThrow(/Invalid calendar date/);
  });

  it("needs depth and time unless the dive is a Draft", async () => {
    const { max_depth: _d, bottom_time_min: _t, ...rest } = base;
    void _d;
    void _t;
    const err = await rejects(service(new FakeBackend()).createDive(rest));
    expect(err.message).toMatch(/max_depth and bottom_time_min are needed/);
    const draft = await service(new FakeBackend()).createDive({ ...rest, status: "Draft" });
    expect(draft.status).toBe("Draft");
  });

  it("checks gas mixes", async () => {
    const s = service(new FakeBackend());
    await expect(s.createDive({ ...base, gas: "Air", oxygen_pct: 32 })).rejects.toThrow(/Air is 21% oxygen/);
    await expect(s.createDive({ ...base, gas: "Trimix" })).rejects.toThrow(/needs oxygen_pct/);
    await expect(s.createDive({ ...base, gas: "Trimix", oxygen_pct: 21, nitrogen_pct: 40, helium_pct: 35 })).rejects.toThrow(/add up to 100/);
    await expect(s.createDive({ ...base, oxygen_pct: 30 })).rejects.toThrow(/need a gas/);
    const b = new FakeBackend();
    await service(b).createDive({ ...base, gas: "Trimix", oxygen_pct: 21, helium_pct: 35 });
    expect(b.inserts[0]!.equipment.data).toMatchObject({ oxygen: 21, nitrogen: 44, helium: 35 });
    await service(b).createDive({ ...base, gas: "Enriched", oxygen_pct: 30 });
    expect(b.inserts[1]!.equipment.data).toMatchObject({ oxygen: 30, nitrogen: 70, helium: 0 });
  });

  it("lists every problem at once", async () => {
    const err = await rejects(service(new FakeBackend()).createDive({ ...base, title: " ", date: "2030-01-01", bottom_time_min: undefined }));
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/title/);
    expect(err.message).toMatch(/future/);
    expect(err.message).toMatch(/bottom_time_min/);
  });

  it("saves training dives as Draft with the course title", async () => {
    const b = new FakeBackend();
    const d = await service(b).createDive({ ...base, title: "my title", training: { course: "Open", log_number: 2, skills: ["Swim Compass", "controlled ascent"] } });
    expect(d.status).toBe("Draft");
    expect(d.title).toBe("Open Water Training Dive 2");
    expect(d.type).toBe("Training");
    expect(d.web_url).toContain("/training/update/");
    expect(b.inserts[0]).toMatchObject({ log_type: "Training", log_course: "Open", log_number: 2, status: "Draft", skills: { data: { dive_skills: '{"swim compass","controlled ascent"}' } } });
    // The same training dive cannot be logged twice.
    await expect(service(b).createDive({ ...base, training: { course: "Open", log_number: 2 } })).rejects.toThrow(/already in your logbook/);
  });

  it("checks the training rules", async () => {
    const s = service(new FakeBackend());
    await expect(s.createDive({ ...base, training: { course: "Open", log_number: 7 } })).rejects.toThrow(/log_number 1, 2, 3, 4/);
    await expect(s.createDive({ ...base, training: { course: "Open", log_number: 1, skills: ["controlled ascent"] } })).rejects.toThrow(/Unknown skill/);
    await expect(s.createDive({ ...base, training: { course: "Advanced", log_number: 5, adventure_dive: "Night" } })).rejects.toThrow(/only for Advanced elective/);
    await expect(s.createDive({ ...base, training: { course: "Advanced", log_number: 5, skills: ["x"] } })).rejects.toThrow(/do not store skills/);
    await expect(s.createDive({ ...base, training: { course: "Advanced", log_number: 7, adventure_dive: "Moon walking" } })).rejects.toThrow(/Unknown adventure_dive/);
    const b = new FakeBackend();
    const d = await service(b).createDive({ ...base, training: { course: "Advanced", log_number: 7, adventure_dive: "night" } });
    expect(d.adventure_dive).toBe("Night Diving");
    const sp = await service(b).createDive({ ...base, title: "Dry suit", training: { course: "SpecialtyAndDistinctive", skills: ["Dry suit"] } });
    expect(sp.title).toBe("Dry suit");
    expect(b.inserts[1]!.log_number).toBeNull();
  });
});

describe("LogbookService changing dives", () => {
  it("reads, merges and writes whole rows, keeping what was not changed", async () => {
    const b = new FakeBackend([dive(5, "2026-01-05", { adventure_dive: "Deep Diving" })]);
    const d = await service(b).updateDive({ dive_id: 5, notes: "New notes", surge: "BigSurge", buddies: null, max_depth: 66, units: "imperial" });
    const u = b.updates[0]!;
    expect(u.general).not.toHaveProperty("log_type");
    expect(u.general.adventure_dive).toBe("Deep Diving");
    expect(u.depthTime).toEqual({ max_depth: 20.117, bottom_time: 35 });
    expect(u.conditions).toMatchObject({ water_type: "Salt", surge: "BigSurge", current: "NoCurrent" });
    expect(u.experience).toEqual({ feeling: "Good", notes: "New notes", buddies: null, dive_center: "Sample Divers" });
    expect(u.skills).toBeUndefined();
    expect(d.notes).toBe("New notes");
    expect(d).not.toHaveProperty("buddies");
    expect(d.max_depth).toBe(66);
  });

  it("inserts missing child rows instead of updating them", async () => {
    const b = new FakeBackend([dive(5, "2026-01-05", { conditions: [], experiences: [] })]);
    await service(b).updateDive({ dive_id: 5, weather: "Rainy" });
    expect(b.updates[0]!.missing).toEqual(["conditions", "experiences"]);
  });

  it("refuses locked dives and empty or invalid changes", async () => {
    const b = new FakeBackend([dive(5, "2026-01-05", { status: "Verified" }), dive(6, "2026-01-06"), dive(7, "2026-01-07", { log_type: "Training", log_course: "Open", log_number: 1, status: "Draft" })]);
    const s = service(b);
    await expect(s.updateDive({ dive_id: 5, notes: "x" })).rejects.toThrow(/cannot be changed: it is Verified/);
    await expect(s.updateDive({ dive_id: 6 })).rejects.toThrow(/Nothing to change/);
    await expect(s.updateDive({ dive_id: 6, skills: ["no skills"] })).rejects.toThrow(/only for training/);
    await expect(s.updateDive({ dive_id: 6, max_depth: null })).rejects.toThrow(/max_depth is needed/);
    await expect(s.updateDive({ dive_id: 7, status: "Publish" })).rejects.toThrow(/stay Draft/);
    await expect(s.updateDive({ dive_id: 99, notes: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(b.updates).toHaveLength(0);
  });

  it("updates the skills of a training dive", async () => {
    const b = new FakeBackend([dive(7, "2026-01-07", { log_type: "Training", log_course: "Open", log_number: 2, status: "Draft", skills: [] })]);
    const d = await service(b).updateDive({ dive_id: 7, skills: ["Cramp Removal"] });
    expect(b.updates[0]!.skills).toEqual({ dive_skills: '{"cramp removal"}' });
    expect(b.updates[0]!.missing).toEqual(["skills"]);
    expect(d.skills).toEqual(["cramp removal"]);
  });

  it("serialises writes of one service", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05"), dive(2, "2026-01-06")]);
    b.delayMs = 20;
    const s = service(b);
    await Promise.all([s.updateDive({ dive_id: 1, notes: "a" }), s.updateDive({ dive_id: 2, notes: "b" })]);
    expect(b.log).toEqual(["update-start:1", "update-end:1", "update-start:2", "update-end:2"]);
  });

  it("deletes only with the title as confirmation and returns the dive", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05", { dive_title: " Blue Corner " }), dive(2, "2026-01-06", { status: "Pending" })]);
    const s = service(b);
    await expect(s.deleteDive({ dive_id: 1, confirm_title: "Blue" })).rejects.toThrow(/confirm_title does not match.*"Blue Corner"/);
    await expect(s.deleteDive({ dive_id: 2, confirm_title: "Dive 2" })).rejects.toThrow(/waiting for verification/);
    expect(b.deleted).toEqual([]);
    const res = await s.deleteDive({ dive_id: 1, confirm_title: "  blue corner" });
    expect(res.deleted).toBe(true);
    expect(res.dive.title).toBe("Blue Corner");
    expect(b.deleted).toEqual([1]);
    // A dive without a title is confirmed with its id.
    b.logs.set(3, dive(3, "2026-01-07", { dive_title: "  " }));
    await expect(s.deleteDive({ dive_id: 3, confirm_title: "x" })).rejects.toThrow(/exactly: "3"/);
    expect((await s.deleteDive({ dive_id: 3, confirm_title: "3" })).deleted).toBe(true);
  });

  it("submits for verification after looking the PADI Pro up", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05"), dive(2, "2026-01-06", { status: "Draft", depth_times: [] })]);
    const s = service(b);
    await expect(s.submitForVerification({ dive_id: 1, instructor_number: "999", confirm: true })).rejects.toThrow(/No PADI Pro with member number 999/);
    expect(b.updates).toHaveLength(0);
    await expect(s.submitForVerification({ dive_id: 2, instructor_number: "123456", confirm: true })).rejects.toThrow(/max_depth and bottom_time_min/);
    const res = await s.submitForVerification({ dive_id: 1, instructor_number: "123456", confirm: true });
    expect(b.calls.indexOf("lookupInstructor:123456")).toBeLessThan(b.calls.indexOf("updateLog:1"));
    expect(b.updates[0]!.general).toMatchObject({ status: "Pending", memsys_member_number: 123456 });
    expect(res.instructor).toEqual({ member_number: "123456", found: true, name: "Pat Q Instructor" });
    expect(res.dive.status).toBe("Pending");
    expect(res.dive.locked).toBe(true);
    await expect(s.submitForVerification({ dive_id: 1, instructor_number: "123456", confirm: true })).rejects.toThrow(/cannot be sent for verification/);
  });

  it("checks training dives before submitting them", async () => {
    const b = new FakeBackend([dive(3, "2026-01-07", { log_type: "Training", log_course: "Open", log_number: 2, status: "Draft", skills: [] })]);
    await expect(service(b).submitForVerification({ dive_id: 3, instructor_number: "123456", confirm: true })).rejects.toThrow(/Pick at least one skill/);
  });

  it("refuses every write on a read-only account, without calling PADI", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    const s = service(b, { readOnly: true });
    for (const p of [
      s.createDive(base),
      s.updateDive({ dive_id: 1, notes: "x" }),
      s.deleteDive({ dive_id: 1, confirm_title: "Dive 1" }),
      s.submitForVerification({ dive_id: 1, instructor_number: "123456", confirm: true }),
      s.setUnits("metric"),
    ]) {
      await expect(p).rejects.toBeInstanceOf(ReadOnlyError);
    }
    expect(b.calls).toEqual([]);
  });
});
