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
import { NotFoundError, ReadOnlyError, UnconfirmedWriteError, UserFacingError } from "../../src/util/errors.js";

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
  photoTypes: Record<string, string> = {};
  /** Errors to throw, to test what happens when PADI fails. */
  fail: { getUnits?: Error; getLogAfterWrite?: Error; insertLog?: Error; listPhotoIds?: Error } = {};
  private wrote = false;
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
    if (this.wrote && this.fail.getLogAfterWrite) throw this.fail.getLogAfterWrite;
    const d = this.logs.get(id);
    return d ? structuredClone(d) : undefined;
  }
  async insertLog(payload: WireLogInsert): Promise<number> {
    this.calls.push("insertLog");
    if (this.fail.insertLog) throw this.fail.insertLog;
    this.wrote = true;
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
    this.wrote = true;
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
    if (this.fail.getUnits) throw this.fail.getUnits;
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
    if (this.fail.listPhotoIds) throw this.fail.listPhotoIds;
    return Object.keys(this.photos);
  }
  async getPhoto(_logId: number, photoId: string): Promise<{ data: Buffer; mimeType: string }> {
    return { data: this.photos[photoId]!, mimeType: this.photoTypes[photoId] ?? "image/jpeg" };
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

  it("refuses only dates that are in the future everywhere on Earth, whatever the server's time zone", async () => {
    // 23:00 UTC on 9 November: in Sydney it is already 10 November (a morning dive).
    const late = () => new Date("2026-11-09T23:00:00Z");
    const d = await service(new FakeBackend(), { clock: late }).createDive({ ...base, date: "2026-11-10" });
    expect(d.date).toBe("2026-11-10");
    const err = await rejects(service(new FakeBackend(), { clock: late }).createDive({ ...base, date: "2026-11-11" }));
    expect(err.message).toMatch(/2026-11-11 is in the future/);
    // The server's own date is not given as the user's today.
    expect(err.message).not.toMatch(/today is/);
    // 09:59 UTC: it is not yet 10 November anywhere (UTC+14 is 23:59 on 9 November).
    const early = () => new Date("2026-11-09T09:59:00Z");
    await expect(service(new FakeBackend(), { clock: early }).createDive({ ...base, date: "2026-11-10" })).rejects.toThrow(/in the future/);
    expect((await service(new FakeBackend(), { clock: early }).createDive({ ...base, date: "2026-11-09" })).date).toBe("2026-11-09");
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

  it("asks for a date when a stored dive has none, instead of failing inside", async () => {
    const b = new FakeBackend([dive(5, "2026-01-05", { dive_date: null })]);
    const s = service(b);
    await expect(s.updateDive({ dive_id: 5, notes: "x" })).rejects.toThrow(/has no date\. Give date \(YYYY-MM-DD\)/);
    expect(b.updates).toHaveLength(0);
    await s.updateDive({ dive_id: 5, notes: "x", date: "2026-01-05" });
    expect(b.updates).toHaveLength(1);
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
    // The error never gives the stored title, so it cannot be resent without asking the user.
    const mismatch = await rejects(s.deleteDive({ dive_id: 1, confirm_title: "Blue" }));
    expect(mismatch.message).toMatch(/Dive 1 is not titled "Blue"\. Nothing was deleted/);
    expect(mismatch.message).toMatch(/ask the user/);
    expect(mismatch.message).not.toMatch(/Blue Corner/i);
    await expect(s.deleteDive({ dive_id: 2, confirm_title: "Dive 2" })).rejects.toThrow(/waiting for verification/);
    expect(b.deleted).toEqual([]);
    const res = await s.deleteDive({ dive_id: 1, confirm_title: "  blue corner" });
    expect(res.deleted).toBe(true);
    expect(res.dive.title).toBe("Blue Corner");
    expect(b.deleted).toEqual([1]);
    // A dive without a title is confirmed with its id.
    b.logs.set(3, dive(3, "2026-01-07", { dive_title: "  " }));
    const noTitle = await rejects(s.deleteDive({ dive_id: 3, confirm_title: "x" }));
    expect(noTitle.message).toMatch(/not titled "x"/);
    expect(b.deleted).toEqual([1]);
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

describe("LogbookService: training skills as the PADI form offers them", () => {
  it("takes the ReActivate requirements and the Rescue exercises, and nothing else", async () => {
    const b = new FakeBackend();
    const s = service(b);
    const re = await s.createDive({ ...base, training: { course: "Reactivate", log_number: 13, skills: ["Mask flood", "alternate air", "log dive", "panicked diver"] } });
    expect(re.skills).toEqual(["mask flood", "alternate air", "log dive", "panicked diver"]);
    // The form's label of "panicked diver" is accepted too (a ReActivate dive can be logged again).
    const label = await s.createDive({ ...base, training: { course: "Reactivate", log_number: 13, skills: ["Buoyancy/weight check", "weight drop"] } });
    expect(label.skills).toEqual(["panicked diver", "weight drop"]);
    // ReActivate offers neither the flexible skills nor "no skills".
    await expect(s.createDive({ ...base, training: { course: "Reactivate", log_number: 13, skills: ["no skills"] } })).rejects.toThrow(/Unknown skill "no skills"\. For this Reactivate dive use: mask flood/);
    await expect(s.createDive({ ...base, training: { course: "Rescue", log_number: 10, skills: ["cramp removal"] } })).rejects.toThrow(/Unknown skill "cramp removal"/);
    const rescue = await s.createDive({ ...base, training: { course: "Rescue", log_number: 11, skills: ["tired diver", "missing diver"] } });
    expect(rescue.skills).toEqual(["tired diver", "missing diver"]);
    // Open Water keeps the flexible skills.
    expect((await s.createDive({ ...base, training: { course: "Open", log_number: 1, skills: ["no skills"] } })).skills).toEqual(["no skills"]);
  });

  it("asks for a skill without suggesting \"no skills\" where the course has none", async () => {
    const b = new FakeBackend([dive(3, "2026-01-07", { log_type: "Training", log_course: "Rescue", log_number: 10, status: "Draft", skills: [] })]);
    const err = await rejects(service(b).submitForVerification({ dive_id: 3, instructor_number: "123456", confirm: true }));
    expect(err.message).toMatch(/Pick at least one skill: tired diver/);
    expect(err.message).not.toMatch(/no skills/);
  });

  it("changes and sends a dive whose stored skills the current form does not offer", async () => {
    // Stored by an older app version: a flexible skill on a ReActivate dive.
    const old = dive(4, "2026-01-08", { log_type: "Training", log_course: "Reactivate", log_number: 13, status: "Draft", skills: [{ dive_skills: ["cramp removal"] }] });
    const b = new FakeBackend([old]);
    const s = service(b);
    const changed = await s.updateDive({ dive_id: 4, notes: "Back in the water" });
    expect(changed.notes).toBe("Back in the water");
    expect(changed.skills).toEqual(["cramp removal"]);
    const sent = await s.submitForVerification({ dive_id: 4, instructor_number: "123456", confirm: true });
    expect(sent.dive.status).toBe("Pending");
    // A change of the skills themselves is checked.
    b.logs.set(5, { ...structuredClone(old), id: 5 });
    await expect(s.updateDive({ dive_id: 5, skills: ["cramp removal"] })).rejects.toThrow(/Unknown skill/);
    expect((await s.updateDive({ dive_id: 5, skills: ["weight drop"] })).skills).toEqual(["weight drop"]);
  });
});

describe("LogbookService: gas changes on update", () => {
  const withGas = (gas: string, o: number, n: number, h: number) =>
    dive(1, "2026-01-05", { equipment: [{ ...dive(1, "2026-01-05").equipment![0]!, gas_mixture: gas as never, oxygen: o, nitrogen: n, helium: h }] });

  it("does not keep the percentages of the old gas", async () => {
    const air = () => service(new FakeBackend([withGas("Air", 21, 79, 0)]));
    await expect(air().updateDive({ dive_id: 1, gas: "Enriched" })).rejects.toThrow(/Gas Enriched needs oxygen_pct/);
    await expect(service(new FakeBackend([withGas("Enriched_32", 32, 68, 0)])).updateDive({ dive_id: 1, gas: "Rebreather" })).rejects.toThrow(/Gas Rebreather needs oxygen_pct/);
    const nitrox = await air().updateDive({ dive_id: 1, gas: "Enriched", oxygen_pct: 30 });
    expect([nitrox.gas, nitrox.oxygen_pct, nitrox.nitrogen_pct, nitrox.helium_pct]).toEqual(["Enriched", 30, 70, 0]);
    const trimix = await air().updateDive({ dive_id: 1, gas: "Trimix", oxygen_pct: 21, helium_pct: 35 });
    expect([trimix.oxygen_pct, trimix.nitrogen_pct, trimix.helium_pct]).toEqual([21, 44, 35]);
  });

  it("keeps a custom mix when the same gas is given again, and fills nitrogen again when oxygen changes", async () => {
    const same = await service(new FakeBackend([withGas("Enriched", 30, 70, 0)])).updateDive({ dive_id: 1, gas: "Enriched" });
    expect([same.oxygen_pct, same.nitrogen_pct, same.helium_pct]).toEqual([30, 70, 0]);
    const richer = await service(new FakeBackend([withGas("Enriched", 30, 70, 0)])).updateDive({ dive_id: 1, oxygen_pct: 32 });
    expect([richer.oxygen_pct, richer.nitrogen_pct, richer.helium_pct]).toEqual([32, 68, 0]);
    const air = await service(new FakeBackend([withGas("Enriched", 30, 70, 0)])).updateDive({ dive_id: 1, gas: "Air" });
    expect([air.oxygen_pct, air.nitrogen_pct, air.helium_pct]).toEqual([21, 79, 0]);
  });
});

describe("LogbookService: units that cannot be read", () => {
  it("never guesses the units of numbers in a write, but answers reads in metric", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.units = "Imperial";
    b.fail.getUnits = new UserFacingError("The PADI logbook answered HTTP 503.");
    const s = service(b, { units: "auto" });
    const err = await rejects(s.createDive({ ...base, max_depth: 60 }));
    expect(err.message).toMatch(/Could not read your PADI units setting/);
    expect(err.message).toMatch(/units "metric" or "imperial"/);
    await expect(s.updateDive({ dive_id: 1, max_depth: 60 })).rejects.toThrow(/Could not read your PADI units setting/);
    expect(b.inserts).toHaveLength(0);
    expect(b.updates).toHaveLength(0);
    // With the units named, or without numbers, the write goes ahead.
    expect((await s.createDive({ ...base, max_depth: 60, units: "imperial" })).max_depth).toBe(60);
    expect(b.inserts[0]!.depth_times.data.max_depth).toBe(18.288);
    expect((await s.updateDive({ dive_id: 1, notes: "No numbers" })).notes).toBe("No numbers");
    // Reads are labelled, so they may fall back to metric.
    expect((await s.getDive({ dive_id: 1 })).units.depth).toBe("m");
  });

  it("keeps using the last known setting when PADI does not answer after the cache expired", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.units = "Imperial";
    let now = NOW.getTime();
    const s = service(b, { units: "auto", clock: () => new Date(now) });
    expect((await s.getDive({ dive_id: 1 })).units.depth).toBe("ft");
    now += 6 * 60_000;
    b.fail.getUnits = new UserFacingError("The PADI logbook did not answer.");
    const d = await s.createDive({ ...base, max_depth: 60 });
    expect(d.units.depth).toBe("ft");
    expect(b.inserts[0]!.depth_times.data.max_depth).toBe(18.288);
  });
});

describe("LogbookService: writes whose answer is lost", () => {
  it("returns the new dive when it cannot be read back, so it is not logged twice", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.fail.getLogAfterWrite = new UserFacingError("The PADI logbook did not answer within 20 s. Try again later.");
    const d = await service(b).createDive({ ...base, notes: "Kept" });
    expect(d.id).toBe(1000);
    expect(d.title).toBe("Morning dive");
    expect(d.date).toBe("2026-11-01");
    expect(d.max_depth).toBe(18);
    expect(d.notes).toBe("Kept");
    expect(d.note).toMatch(/Saved, but PADI did not return the saved dive/);
    expect(b.logs.size).toBe(2);
  });

  it("returns the changed dive and the sent dive when they cannot be read back", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.fail.getLogAfterWrite = new UserFacingError("The PADI logbook answered HTTP 503.");
    const changed = await service(b).updateDive({ dive_id: 1, notes: "Changed", max_depth: 25 });
    expect([changed.id, changed.notes, changed.max_depth, changed.type]).toEqual([1, "Changed", 25, "Recreational"]);
    expect(changed.note).toMatch(/logbook_get_dive/);
    expect(b.updates).toHaveLength(1);
    const c = new FakeBackend([dive(2, "2026-01-06")]);
    c.fail.getLogAfterWrite = new UserFacingError("The PADI logbook answered HTTP 503.");
    const sent = await service(c).submitForVerification({ dive_id: 2, instructor_number: "123456", confirm: true });
    expect(sent.dive.status).toBe("Pending");
    expect(sent.dive.instructor_number).toBe("123456");
    expect(sent.dive.note).toMatch(/Saved/);
  });

  it("says a write without an answer may have been saved, and how to check", async () => {
    const b = new FakeBackend();
    b.fail.insertLog = new UnconfirmedWriteError();
    const err = await rejects(service(b).createDive(base));
    expect(err).toBeInstanceOf(UnconfirmedWriteError);
    expect(err.message).toMatch(/"Morning dive" on 2026-11-01/);
    expect(err.message).toMatch(/logbook_list_dives \(from 2026-11-01, to 2026-11-01\)/);
    expect(err.message).not.toMatch(/try again later/i);
  });
});

describe("LogbookService: deleting a dive with photos", () => {
  it("refuses, since the photos would stay on PADI without a dive", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.photos = { a: Buffer.alloc(10), b: Buffer.alloc(10) };
    const err = await rejects(service(b).deleteDive({ dive_id: 1, confirm_title: "Dive 1" }));
    expect(err.message).toMatch(/Dive 1 has 2 photos/);
    expect(err.message).toMatch(/learning\.padi\.com.*\/recreational\/update\/1/);
    expect(b.deleted).toEqual([]);
  });

  it("deletes when the photo service does not answer, and says so", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.fail.listPhotoIds = new UserFacingError("The PADI photo service answered HTTP 503.");
    const res = await service(b).deleteDive({ dive_id: 1, confirm_title: "Dive 1" });
    expect(res.deleted).toBe(true);
    expect(res.photos_checked).toBe(false);
    expect(res.note).toMatch(/not known whether the dive had photos/);
    expect(b.deleted).toEqual([1]);
    // Without photos there is no note.
    const c = new FakeBackend([dive(2, "2026-01-06")]);
    expect(await service(c).deleteDive({ dive_id: 2, confirm_title: "Dive 2" })).not.toHaveProperty("note");
  });
});

describe("LogbookService: reading, more", () => {
  it("sorts by depth and time with dives without a value last, in a stable order for paging", async () => {
    const b = new FakeBackend([
      dive(1, "2026-01-01", { depth_times: [{ max_depth: 18, bottom_time: 40, time_in: null, time_out: null }] }),
      dive(2, "2026-01-02", { depth_times: [{ max_depth: 18, bottom_time: 40, time_in: null, time_out: null }] }),
      dive(3, "2026-01-02", { depth_times: [{ max_depth: 18, bottom_time: 40, time_in: null, time_out: null }] }),
      dive(4, "2026-01-04", { status: "Draft", depth_times: [{ max_depth: null, bottom_time: null, time_in: null, time_out: null }] }),
      dive(5, "2026-01-05", { depth_times: [{ max_depth: 30, bottom_time: 25, time_in: null, time_out: null }] }),
      dive(6, "2026-01-06", { status: "Draft", depth_times: [] }),
    ]);
    const s = service(b);
    const deep = await s.listDives({ sort: "max_depth" });
    expect(deep.dives.map((d) => d.id)).toEqual([5, 3, 2, 1, 6, 4]);
    expect((await s.listDives({ sort: "bottom_time" })).dives.map((d) => d.id)).toEqual([3, 2, 1, 5, 6, 4]);
    const pages = [...(await s.listDives({ sort: "max_depth", limit: 2 })).dives, ...(await s.listDives({ sort: "max_depth", limit: 2, offset: 2 })).dives, ...(await s.listDives({ sort: "max_depth", limit: 2, offset: 4 })).dives];
    expect(pages.map((d) => d.id)).toEqual([5, 3, 2, 1, 6, 4]);
    expect(deep.total).toBe(6);
    expect(b.calls.filter((c) => c.startsWith("listLogs:")).every((c) => c.includes('"orderBy":"date"'))).toBe(true);
  });

  it("lists dives in the units the call names", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    const res = await service(b).listDives({ units: "imperial" });
    expect(res.units.depth).toBe("ft");
    expect(res.dives[0]!.max_depth).toBe(36.1);
    expect(z.strictObject(listDivesShape).parse({ units: "imperial" }).units).toBe("imperial");
  });

  it("leaves out photos AI apps cannot show (HEIC, not an image) and says where to see them", async () => {
    const b = new FakeBackend([dive(1, "2026-01-05")]);
    b.photos = { heic: Buffer.alloc(50), body: Buffer.from('{"error":"x"}'), ok: Buffer.alloc(50) };
    b.photoTypes = { heic: "image/heic", body: "application/octet-stream", ok: "image/png" };
    const res = await service(b).getPhotos({ dive_id: 1, max: 5 });
    expect(res.photos.map((p) => [p.id, p.mimeType])).toEqual([["ok", "image/png"]]);
    expect(res.skipped).toBe(2);
    expect(res.skipped_unsupported).toEqual([
      { id: "heic", mimeType: "image/heic" },
      { id: "body", mimeType: "application/octet-stream" },
    ]);
    expect(res.web_url).toContain("/update/1");
    // Only unsupported photos: an answer without images, not an error.
    b.photos = { heic: Buffer.alloc(50) };
    const none = await service(b).getPhotos({ dive_id: 1 });
    expect(none.photos).toEqual([]);
    expect(none.skipped_unsupported).toHaveLength(1);
  });

  it("exports in parts, oldest first, with compact JSON", async () => {
    const b = new FakeBackend([1, 2, 3, 4, 5].map((n) => dive(n, `2026-01-0${n}`)));
    const s = service(b);
    const first = await s.exportDives({ format: "json", limit: 2 });
    expect([first.total, first.count, first.offset, first.next_offset]).toEqual([5, 2, 0, 2]);
    const dives = JSON.parse(first.content) as Array<Record<string, unknown>>;
    expect(dives.map((d) => d.id)).toEqual([1, 2]);
    expect(dives[0]).not.toHaveProperty("units");
    expect(first.content).not.toContain("\n  ");
    const last = await s.exportDives({ format: "csv", limit: 2, offset: 4 });
    expect([last.count, last.next_offset]).toEqual([1, undefined]);
    expect(last.content.trim().split("\r\n")).toHaveLength(2);
    // The defaults keep an answer small enough for AI apps.
    const big = new FakeBackend(Array.from({ length: 120 }, (_, i) => dive(i + 1, "2026-01-01")));
    expect((await service(big).exportDives({ format: "json" })).count).toBe(50);
    expect((await service(big).exportDives({ format: "csv" })).count).toBe(100);
    expect((await service(big).exportDives({ format: "json", offset: 200 })).content).toBe("[]");
  });
});

describe("LogbookService: null on create", () => {
  it("accepts null for every optional field (null means not given)", async () => {
    const create = z.strictObject(createDiveShape);
    const args = create.parse({ ...base, surge: null, notes: null, gas: null, oxygen_pct: null, equipment: null, status: null, training: null, units: "metric" });
    const b = new FakeBackend();
    const d = await service(b).createDive(args as CreateDiveArgs);
    expect(d.status).toBe("Publish");
    expect(d).not.toHaveProperty("surge");
    expect(b.inserts[0]!.experiences.data.notes).toBeNull();
    const training = create.parse({ ...base, training: { course: "Advanced", log_number: 5, adventure_dive: null, skills: null } });
    expect((await service(b).createDive(training as CreateDiveArgs)).title).toBe("Adventure Dive - Deep");
  });
});
