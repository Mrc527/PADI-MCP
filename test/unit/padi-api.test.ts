import { describe, expect, it } from "vitest";
import { ECARD_IMAGE_BASE, ecardDate, PadiApi, photoIdsFrom, sniffImageType } from "../../src/padi/api.js";
import { PadiSession } from "../../src/padi/session.js";
import type { WireLogInsert, WireLogUpdate } from "../../src/logbook/types.js";
import { NotFoundError } from "../../src/util/errors.js";
import { AFFILIATE_ID, cognitoOk, ENDPOINTS, idToken, json, mockFetch, type Recorded, type Responder } from "./padi-fixtures.js";

const T0 = 1_800_000_000_000;

function api(responder: Responder, mode: "proxy" | "direct" | "auto" = "proxy", opts: { pro?: boolean } = {}) {
  const m = mockFetch(responder);
  const session = new PadiSession({
    tokens: {
      refreshToken: "stored",
      loginMethod: "cognito",
      clientId: "c",
      idToken: idToken({ nowMs: T0, typeId: opts.pro ? "2" : "1" }),
      idTokenExpiresAt: T0 + 3_600_000,
    },
    method: "auto",
    endpoints: ENDPOINTS,
    fetch: m.fetch,
    backoffMs: 0,
    now: () => T0 + 1000,
  });
  return { api: new PadiApi({ session, endpoints: ENDPOINTS, apiMode: mode, fetch: m.fetch, backoffMs: 0 }), requests: m.requests };
}

const gqlBody = (r: Recorded) => r.json as { query: string; variables: Record<string, unknown> };

const insertPayload: WireLogInsert = {
  affiliate_id: "99999999",
  log_type: "Recreational",
  log_course: null,
  log_number: null,
  created_date: "2026-11-09T12:00:00",
  update_date: "2026-11-09T12:00:00",
  dive_type: "Boat",
  dive_title: "Reef",
  dive_location: "Example Reef",
  dive_date: "11/01/2026",
  status: "Publish",
  memsys_member_number: null,
  depth_times: { data: { max_depth: 18, bottom_time: 40 } },
  conditions: { data: {} },
  equipment: { data: {} },
  experiences: { data: {} },
};

const update = (overrides: Partial<WireLogUpdate> = {}): WireLogUpdate => ({
  id: 42,
  general: { log_type: "Recreational", created_date: "x", affiliate_id: "99999999", dive_title: "Reef", status: "Publish", log_course: null },
  depthTime: { max_depth: 10, bottom_time: 30 },
  conditions: { water_type: "Salt" },
  equipment: { suit_type: "Shorty" },
  experience: { notes: "n" },
  ...overrides,
});

describe("PadiApi reads", () => {
  it("lists dives with the requested selection and order", async () => {
    const { api: a, requests } = api(() => json({ data: { logbook_logs: [{ id: "12", log_number: "0", dive_title: "A" }] } }));
    const rows = await a.listLogs({ limit: 15, offset: 30, orderBy: "max_depth", withDepthTime: true, logType: "Training" });
    expect(rows).toEqual([{ id: 12, log_number: 0, dive_title: "A" }]);
    const { query, variables } = gqlBody(requests[0]!);
    expect(query).toContain("$log_type: log_type");
    expect(query).toContain("order_by: { depth_times_aggregate: { max: { max_depth: desc } } }");
    expect(query).toContain("dive_type depth_times { max_depth bottom_time }");
    expect(query).not.toContain("conditions");
    expect(variables).toEqual({ affiliate_id: 10000001, log_type: "Training", limit: 15, offset: 30 });

    await a.listLogs({ limit: null, full: true });
    const full = gqlBody(requests[1]!);
    expect(full.query).toContain("order_by: { dive_date: desc, id: desc }");
    expect(full.query).toContain("experiences { feeling notes buddies dive_center }");
    expect(full.query).toContain("additional_equipment");
    expect(full.variables.limit).toBeNull();
  });

  it("filters by status on its side when both log type and status are asked", async () => {
    const { api: a, requests } = api(() =>
      json({ data: { logbook_logs: [{ id: 1, status: "Draft" }, { id: 2, status: "Verified" }, { id: 3, status: "Draft" }] } }),
    );
    const rows = await a.listLogs({ logType: "Training", status: "Draft", limit: 1, offset: 1 });
    expect(rows.map((r) => r.id)).toEqual([3]);
    expect(gqlBody(requests[0]!).variables).toMatchObject({ log_type: "Training", limit: null, offset: 0 });
    expect(gqlBody(requests[0]!).query).not.toContain("$status");
  });

  it("counts dives and sums bottom time", async () => {
    const { api: a, requests } = api((req) =>
      gqlBody(req).query.includes("logbook_depth_time_aggregate")
        ? json({ data: { logbook_depth_time_aggregate: { aggregate: { sum: { bottom_time: "1234" } } } } })
        : json({ data: { logbook_logs_aggregate: { aggregate: { count: 26 } } } }),
    );
    expect(await a.countLogs({ status: "Draft" })).toBe(26);
    expect(gqlBody(requests[0]!).query).toContain("status: { _eq: $status }");
    expect(await a.totalBottomTime()).toBe(1234);
    expect(gqlBody(requests[1]!).query).toContain("where: { log: { affiliate_id: { _eq: $affiliate_id } } }");
  });

  it("gets one dive (direct mode: no affiliate filter)", async () => {
    const { api: a, requests } = api(() => json({ data: { logbook_logs: [{ id: 42, dive_title: "X" }] } }), "direct");
    expect((await a.getLog(42))?.dive_title).toBe("X");
    expect(gqlBody(requests[0]!).query).toContain("query logbook_logs($id: Int!) { logbook_logs(where: { _and: { id: { _eq: $id } } })");
    expect(gqlBody(requests[0]!).variables).toEqual({ id: 42 });
    const empty = api(() => json({ data: { logbook_logs: [] } }));
    expect(await empty.api.getLog(1)).toBeUndefined();
  });

  it("searches sites and reads the units setting", async () => {
    const { api: a, requests } = api((req) =>
      gqlBody(req).query.includes("logbook_dive_site")
        ? json({ data: { logbook_dive_site: [{ id: 1, name: "Reef A" }, { id: "2", name: "Reef B" }, { id: 3, name: " " }, { id: 4, name: "Reef C" }] } })
        : json({ data: { logbook_units_settings: [] } }),
    );
    expect(await a.searchSites("%reef%", 2)).toEqual([
      { id: 1, name: "Reef A" },
      { id: 2, name: "Reef B" },
    ]);
    expect(gqlBody(requests[0]!).variables).toEqual({ name: "%reef%" });
    expect(await a.getUnits()).toBe("Metric");
  });
});

describe("PadiApi writes", () => {
  it("inserts a dive with the affiliate id from the token, never the caller's", async () => {
    const { api: a, requests } = api(() => json({ data: { insert_logbook_logs: { affected_rows: 5, returning: [{ id: 777 }] } } }));
    expect(await a.insertLog(insertPayload)).toBe(777);
    const { query, variables } = gqlBody(requests[0]!);
    expect(query.startsWith("mutation insert_logbook_logs($general: [logbook_logs_insert_input!]!)")).toBe(true);
    expect((variables.general as Record<string, unknown>).affiliate_id).toBe(10000001);
    expect(requests[0]!.headers["affiliate-id"]).toBe(AFFILIATE_ID);
  });

  it("names the insert insert_divelog in direct mode and refuses 0 rows", async () => {
    const { api: a, requests } = api(() => json({ data: { insert_logbook_logs: { affected_rows: 0, returning: [] } } }), "direct");
    await expect(a.insertLog(insertPayload)).rejects.toThrow(/did not save/);
    expect(gqlBody(requests[0]!).query.startsWith("mutation insert_divelog(")).toBe(true);
    expect(requests[0]!.headers["x-hasura-role"]).toBe("user");
  });

  it("updates without log_type and created_date, with the right document", async () => {
    const ok = () => json({ data: { update_logbook_logs: { affected_rows: 1 } } });
    const { api: a, requests } = api(ok);
    await a.updateLog(update());
    const rec = gqlBody(requests[0]!);
    expect(rec.query.startsWith("mutation UpdateRecreationalDiveLog($id: Int!, $general: logbook_logs_set_input!")).toBe(true);
    expect(rec.query).not.toContain("update_logbook_skills");
    expect(rec.variables.general).toEqual({ dive_title: "Reef", status: "Publish", log_course: null, affiliate_id: 10000001 });
    expect(rec.variables).not.toHaveProperty("skills");

    await a.updateLog(update({ general: { log_course: "Open", dive_title: "T" }, skills: { dive_skills: "{x}" } }));
    const training = gqlBody(requests[1]!);
    expect(training.query).toContain("$skills: logbook_skills_set_input!");
    expect(training.query).toContain("update_logbook_skills(where: { logs_id: { _eq: $id } }, _set: $skills)");
    expect(training.query.startsWith("mutation UpdateRecreationalDiveLog(")).toBe(true);

    await a.updateLog(update({ general: { log_course: "Advanced" } }));
    expect(gqlBody(requests[2]!).query.startsWith("mutation UpdateTrainingDiveLogWithoutSkills(")).toBe(true);

    const direct = api(ok, "direct");
    await direct.api.updateLog(update({ general: { log_course: "Open" }, skills: { dive_skills: null } }));
    expect(gqlBody(direct.requests[0]!).query.startsWith("mutation UpdateTrainingDiveLog(")).toBe(true);
  });

  it("inserts the child rows a dive does not have yet", async () => {
    const { api: a, requests } = api(() => json({ data: { update_logbook_logs: { affected_rows: 1 }, insert_logbook_conditions: { affected_rows: 1 } } }));
    await a.updateLog(update({ general: { log_course: "Open" }, skills: { dive_skills: "{a}" }, missing: ["conditions", "skills"] }));
    expect(requests).toHaveLength(2);
    // The update itself goes without the skills part (that row does not exist yet).
    expect(gqlBody(requests[0]!).query).not.toContain("update_logbook_skills");
    const ins = gqlBody(requests[1]!);
    expect(ins.query).toBe(
      "mutation insert_missing_rows($conditions: [logbook_conditions_insert_input!]!, $skills: [logbook_skills_insert_input!]!) { insert_logbook_conditions(objects: $conditions) { affected_rows } insert_logbook_skills(objects: $skills) { affected_rows } }",
    );
    expect(ins.variables).toEqual({ conditions: [{ water_type: "Salt", logs_id: 42 }], skills: [{ dive_skills: "{a}", logs_id: 42 }] });
  });

  it("reports an update that changed nothing", async () => {
    const { api: a } = api(() => json({ data: { update_logbook_logs: { affected_rows: 0 } } }));
    await expect(a.updateLog(update())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes the child tables first, then the dive, in one document", async () => {
    const { api: a, requests } = api(() => json({ data: { delete_logbook_logs: { affected_rows: 1, returning: [{ id: 42 }] } } }));
    await a.deleteLog(42);
    const { query, variables } = gqlBody(requests[0]!);
    expect(query.startsWith("mutation delete_logbook_logs($id: Int) {")).toBe(true);
    const order = ["delete_logbook_depth_time", "delete_logbook_skills", "delete_logbook_conditions", "delete_logbook_experience", "delete_logbook_equipment", "delete_logbook_logs(where"].map((t) => query.indexOf(t));
    expect(order.every((pos, i) => pos > 0 && (i === 0 || pos > order[i - 1]!))).toBe(true);
    expect(query).toContain("returning { id }");
    expect(variables).toEqual({ id: 42 });

    const direct = api(() => json({ data: { delete_logbook_logs: { affected_rows: 0 } } }), "direct");
    await expect(direct.api.deleteLog(42)).rejects.toBeInstanceOf(NotFoundError);
    const dq = gqlBody(direct.requests[0]!).query;
    expect(dq.startsWith("mutation delete_logbook_logs($id: Int!) {")).toBe(true);
    expect(dq).not.toContain("returning");
  });

  it("saves the units setting with the upsert", async () => {
    const { api: a, requests } = api(() => json({ data: { insert_logbook_units_settings: { returning: [{ affiliate_id: 1, unit: "Imperial" }] } } }));
    await a.setUnits("Imperial");
    expect(gqlBody(requests[0]!).query).toContain("on_conflict: { constraint: units_settings_pkey, update_columns: unit }");
    expect(gqlBody(requests[0]!).variables).toEqual({ affiliate_id: 10000001, unit: "Imperial" });
    const direct = api(() => json({ data: { insert_logbook_units_settings: { returning: [] } } }), "direct");
    await expect(direct.api.setUnits("Metric")).rejects.toThrow(/units setting/);
  });
});

describe("PadiApi REST endpoints", () => {
  it("looks an instructor up on the endpoint of the mode", async () => {
    const answer = { results: [{ memberNumber: 123456, firstName: "Pat", middleInitial: "Q", lastName: "Instructor" }] };
    const { api: a, requests } = api(() => json(answer));
    expect(await a.lookupInstructor("123456")).toEqual([{ memberNumber: 123456, name: "Pat Q Instructor" }]);
    expect(requests[0]!.url).toBe(`${ENDPOINTS.instructorUrl}/123456`);
    expect(requests[0]!.headers["x-platform"]).toBe("web");
    expect(requests[0]!.headers["affiliate-id"]).toBe(AFFILIATE_ID);
    const direct = api(() => json({ results: [{ memberNumber: -1 }] }), "direct");
    expect(await direct.api.lookupInstructor("42")).toEqual([]);
    expect(direct.requests[0]!.url).toBe(`${ENDPOINTS.directInstructorUrl}/42`);
    const notFound = api(() => new Response("", { status: 404 }));
    expect(await notFound.api.lookupInstructor("42")).toEqual([]);
    expect(await notFound.api.lookupInstructor("../x")).toEqual([]);
    expect(notFound.requests).toHaveLength(1);
  });

  it("lists eCards (consumer and pro endpoints)", async () => {
    const card = { cardTitle: "Open Water Diver", certDate: "14-SEP-2024", padiNumber: "2409AB1234", instructorName: "Pat Instructor", instructorNumber: 123456, storeName: "Sample Divers", eCardStockID: "OWD01", licenseID: 555 };
    const { api: a, requests } = api(() => json({ affiliateSummary: { affiliateID: 10000001 }, eCardInfo: [card, { cardTitle: "" }] }));
    expect(await a.listCertifications()).toEqual([
      {
        title: "Open Water Diver",
        certDate: "2024-09-14",
        padiNumber: "2409AB1234",
        instructorName: "Pat Instructor",
        instructorNumber: "123456",
        storeName: "Sample Divers",
        licenseId: "555",
        cardImageUrl: `${ECARD_IMAGE_BASE}OWD01.jpg`,
      },
    ]);
    expect(requests[0]!.url).toBe(`${ENDPOINTS.ecardUrl}/GeteCardListConsumer`);
    const pro = api(() => json([]), "proxy", { pro: true });
    expect(await pro.api.listCertifications()).toEqual([]);
    expect(pro.requests[0]!.url).toBe(`${ENDPOINTS.ecardUrl}/GetAlleCardListPro`);
    expect(ecardDate("01/02/2020")).toBe("2020-01-02");
    expect(ecardDate("odd")).toBe("odd");
  });

  it("lists and gets photos (the image without affiliate-id)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const { api: a, requests } = api((req) =>
      req.url.includes("GetImageList") ? json(["a1", 7, { imageId: "b2" }]) : new Response(png, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    expect(await a.listPhotoIds(42)).toEqual(["a1", "7", "b2"]);
    expect(requests[0]!.url).toBe(`${ENDPOINTS.imagesUrl}/GetImageList/42`);
    expect(requests[0]!.headers["affiliate-id"]).toBe(AFFILIATE_ID);
    const photo = await a.getPhoto(42, "a1");
    expect(photo.mimeType).toBe("image/png");
    expect(photo.data.equals(png)).toBe(true);
    expect(requests[1]!.url).toBe(`${ENDPOINTS.imagesUrl}/GetImage/42/a1`);
    expect(requests[1]!.headers["affiliate-id"]).toBeUndefined();
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(photoIdsFrom({ images: ["x"] })).toEqual(["x"]);
  });

  it("refreshes once on HTTP 401 for REST calls", async () => {
    let gql = 0;
    const { api: a, requests } = api((req) => {
      if (req.url === ENDPOINTS.cognitoUrl) return cognitoOk(idToken({ nowMs: T0, extra: { r: 1 } }));
      return ++gql === 1 ? new Response("", { status: 401 }) : json([]);
    });
    expect(await a.listPhotoIds(1)).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual([`${ENDPOINTS.imagesUrl}/GetImageList/1`, ENDPOINTS.cognitoUrl, `${ENDPOINTS.imagesUrl}/GetImageList/1`]);
  });
});

describe("PadiApi account", () => {
  it("answers account() from the token claims, without a request", async () => {
    const { api: a, requests } = api(() => json({}));
    expect(await a.account()).toEqual({
      affiliateId: AFFILIATE_ID,
      email: "alex.tester@example.com",
      name: "Alex Tester",
      isPro: false,
      loginMethod: "cognito",
      apiMode: "proxy",
      tokenExpiresAt: new Date(T0 + 3_600_000).toISOString(),
    });
    expect(requests).toHaveLength(0);
  });

  it("check() counts dives, and reports problems without throwing", async () => {
    const ok = api(() => json({ data: { logbook_logs_aggregate: { aggregate: { count: 3 } } } }), "auto");
    expect(await ok.api.check()).toEqual({ ok: true, dives: 3, apiMode: "auto (proxy)" });
    const bad = api(() => json({ errors: [{ message: "boom", extensions: { code: "unexpected" } }] }));
    const res = await bad.api.check();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });
});
