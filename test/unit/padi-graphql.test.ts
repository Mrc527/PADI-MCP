import { describe, expect, it } from "vitest";
import { listDocument } from "../../src/padi/documents.js";
import { GraphqlClient, graphqlError, PadiGraphqlError } from "../../src/padi/graphql.js";
import { PadiHttpError } from "../../src/padi/http.js";
import { PadiSession } from "../../src/padi/session.js";
import { AFFILIATE_ID, cognitoOk, ENDPOINTS, idToken, json, mockFetch, type Recorded } from "./padi-fixtures.js";

const T0 = 1_800_000_000_000;

/** A session with a valid stored ID token; refreshes go through the same mock (Cognito). */
function session(fetch: typeof globalThis.fetch) {
  return new PadiSession({
    tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c", idToken: idToken({ nowMs: T0, extra: { gen: 0 } }), idTokenExpiresAt: T0 + 3_600_000 },
    method: "auto",
    endpoints: ENDPOINTS,
    fetch,
    backoffMs: 0,
    now: () => T0 + 1000,
  });
}

const isCognito = (req: Recorded) => req.url === ENDPOINTS.cognitoUrl;
let gen = 0;
const refreshed = () => cognitoOk(idToken({ nowMs: T0, extra: { gen: ++gen } }));
const list = (mode: "proxy" | "direct", aff: string) => listDocument(mode, aff, { limit: 5, offset: 0, selection: "summary" });

function client(fetch: typeof globalThis.fetch, mode: "proxy" | "direct" | "auto", log: string[] = []) {
  return new GraphqlClient({ session: session(fetch), endpoints: ENDPOINTS, mode, fetch, backoffMs: 0, log: (m) => void log.push(m) });
}

describe("GraphQL transport", () => {
  it("proxy mode: affiliate-id header and the $affiliate_id document", async () => {
    const m = mockFetch(() => json({ data: { logbook_logs: [] } }));
    await client(m.fetch, "proxy").request(list, { write: false });
    const req = m.requests[0]!;
    expect(req.url).toBe(ENDPOINTS.logbookUrl);
    expect(req.headers.authorization).toMatch(/^Bearer eyJ/);
    expect(req.headers["affiliate-id"]).toBe(AFFILIATE_ID);
    expect(req.headers["x-platform"]).toBe("web");
    expect(req.headers["x-hasura-role"]).toBeUndefined();
    const body = req.json as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("$affiliate_id: Int!");
    expect(body.query).toContain("where: { affiliate_id: { _eq: $affiliate_id } }");
    expect(body.variables).toEqual({ affiliate_id: 10000001, limit: 5, offset: 0 });
  });

  it("direct mode: no affiliate scoping, x-hasura-role only on writes", async () => {
    const m = mockFetch(() => json({ data: { logbook_logs: [] } }));
    const c = client(m.fetch, "direct");
    await c.request(list, { write: false });
    await c.request(list, { write: true });
    const [read, write] = m.requests;
    expect(read!.url).toBe(ENDPOINTS.directUrl);
    expect(read!.headers["affiliate-id"]).toBeUndefined();
    expect(read!.headers["x-hasura-role"]).toBeUndefined();
    expect(write!.headers["x-hasura-role"]).toBe("user");
    const body = read!.json as { query: string; variables: Record<string, unknown> };
    expect(body.query).not.toContain("affiliate_id");
    expect(body.variables).toEqual({ limit: 5, offset: 0 });
  });

  it("refreshes once on HTTP 401 and sends again with the new token", async () => {
    const m = mockFetch((req) => {
      if (isCognito(req)) return refreshed();
      return m.requests.filter((r) => !isCognito(r)).length === 1 ? new Response("", { status: 401 }) : json({ data: { ok: 1 } });
    });
    const data = await client(m.fetch, "proxy").request<{ ok: number }>(list, { write: true });
    expect(data.ok).toBe(1);
    const gql = m.requests.filter((r) => !isCognito(r));
    expect(gql).toHaveLength(2);
    expect(gql[0]!.headers.authorization).not.toBe(gql[1]!.headers.authorization);
    expect(m.requests.filter(isCognito)).toHaveLength(1);
  });

  it("refreshes once on a GraphQL invalid-jwt error", async () => {
    const m = mockFetch((req, i) => {
      if (isCognito(req)) return refreshed();
      return i === 0 ? json({ errors: [{ message: "Could not verify JWT: JWTExpired", extensions: { code: "invalid-jwt", path: "$" } }] }) : json({ data: { ok: 1 } });
    });
    expect(await client(m.fetch, "direct").request(list, { write: false })).toEqual({ ok: 1 });
    expect(m.requests.filter(isCognito)).toHaveLength(1);
  });

  it("gives up after a second 401 (proxy or direct mode)", async () => {
    const m = mockFetch((req) => (isCognito(req) ? refreshed() : new Response("", { status: 401 })));
    const err = await client(m.fetch, "proxy").request(list, { write: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PadiHttpError);
    expect((err as PadiHttpError).status).toBe(401);
    expect(m.requests.filter((r) => !isCognito(r))).toHaveLength(2);
  });

  it("auto mode switches to direct when the proxy still says 401 after a refresh", async () => {
    const log: string[] = [];
    const m = mockFetch((req) => {
      if (isCognito(req)) return refreshed();
      return req.url === ENDPOINTS.logbookUrl ? new Response("", { status: 401 }) : json({ data: { ok: 1 } });
    });
    const c = client(m.fetch, "auto", log);
    expect(await c.request(list, { write: false })).toEqual({ ok: 1 });
    expect(c.mode).toBe("direct");
    expect(c.describeMode()).toBe("auto (direct)");
    expect(log).toHaveLength(1);
    const direct = m.requests.find((r) => r.url === ENDPOINTS.directUrl)!;
    expect((direct.json as { query: string }).query).not.toContain("affiliate_id");
  });

  it("auto mode switches to direct after two proxy failures in a row", async () => {
    const m = mockFetch((req) => (req.url === ENDPOINTS.logbookUrl ? new Response("gone", { status: 404 }) : json({ data: { ok: 1 } })));
    const c = client(m.fetch, "auto");
    expect(await c.request(list, { write: true })).toEqual({ ok: 1 });
    expect(m.requests.map((r) => r.url)).toEqual([ENDPOINTS.logbookUrl, ENDPOINTS.logbookUrl, ENDPOINTS.directUrl]);
    expect(m.requests[2]!.headers["x-hasura-role"]).toBe("user");
    // Later requests go straight to direct.
    await c.request(list, { write: false });
    expect(m.requests[3]!.url).toBe(ENDPOINTS.directUrl);
  });

  it("auto mode does not resend a write that may have reached the proxy", async () => {
    const m = mockFetch(() => json({ message: "boom" }, 502));
    const c = client(m.fetch, "auto");
    await expect(c.request(list, { write: true })).rejects.toThrow(/HTTP 502/);
    expect(m.requests).toHaveLength(1);
    expect(c.mode).toBe("proxy");
    // The second failure in a row switches, but the write is still not resent.
    await expect(c.request(list, { write: true })).rejects.toThrow(/HTTP 502/);
    expect(c.mode).toBe("direct");
    expect(m.requests).toHaveLength(2);
  });

  it("proxy mode (not auto) reports 5xx after the read retries", async () => {
    const m = mockFetch(() => json({}, 503));
    await expect(client(m.fetch, "proxy").request(list, { write: false })).rejects.toThrow(/HTTP 503/);
    expect(m.requests).toHaveLength(3);
  });

  it("maps Hasura errors to clear messages", async () => {
    const m = mockFetch(() => json({ errors: [{ message: 'invalid input value for enum dive_type: "Shore"', extensions: { code: "data-exception", path: "$" } }] }));
    const err = await client(m.fetch, "proxy").request(list, { write: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PadiGraphqlError);
    expect((err as Error).message).toBe('PADI does not accept "Shore" for dive_type.');
    expect((err as PadiGraphqlError).field).toBe("dive_type");
    expect(graphqlError([{ message: 'invalid input value for enum currents: "LightCurrent"' }]).message).toBe('PADI does not accept "LightCurrent" for current.');
    expect(graphqlError([{ message: 'malformed array literal: "Camera"', extensions: { code: "data-exception" } }]).message).toMatch(/list value/);
    expect(graphqlError([{ message: 'Foreign key violation. update or delete on table "logbook_logs" violates foreign key constraint "conditions_logs_id_fkey"', extensions: { code: "constraint-violation" } }]).message).toMatch(/refused the change/);
    expect(graphqlError([{ message: "field 'x' not found in type: 'logbook_logs'", extensions: { code: "validation-failed" } }]).message).toMatch(/may have changed/);
  });

  it("refuses an answer without data", async () => {
    const m = mockFetch(() => json({}));
    await expect(client(m.fetch, "proxy").request(list, { write: false })).rejects.toThrow(/without data/);
  });
});
