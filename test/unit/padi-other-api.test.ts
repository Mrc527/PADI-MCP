/**
 * padi_account_info with check=true also tries the PADI logbook address that is not in use
 * (direct when the server uses the proxy), read-only, and compares the answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PadiApi } from "../../src/padi/api.js";
import { endpointsFromEnv } from "../../src/padi/endpoints.js";
import { PadiSession } from "../../src/padi/session.js";
import { MOCK_ACCOUNT, startMockPadi, type MockPadi } from "../helpers/mock-padi.js";

let mock: MockPadi;

beforeAll(async () => {
  mock = await startMockPadi();
});

afterAll(async () => {
  await mock.close();
});

function api(apiMode: "proxy" | "direct" | "auto", log?: (m: string) => void): PadiApi {
  const endpoints = endpointsFromEnv(mock.env());
  const session = new PadiSession({ email: MOCK_ACCOUNT.email, password: MOCK_ACCOUNT.password, method: "cognito", endpoints, backoffMs: 0 });
  return new PadiApi({ session, endpoints, apiMode, backoffMs: 0, ...(log ? { log } : {}) });
}

const directCalls = () => mock.requests.filter((r) => r.path === "/v1/graphql");
const proxyCalls = () => mock.requests.filter((r) => r.path === "/api/Logbook");

describe("check with compareModes", () => {
  it("tries the direct address read-only and finds the same answers", async () => {
    const before = directCalls().length;
    const logs: string[] = [];
    const result = await api("proxy", (m) => logs.push(m)).check({ compareModes: true });
    expect(result).toMatchObject({ ok: true, apiMode: "proxy", dives: mock.account.store.logs.size });
    expect(result.otherApi).toEqual({
      apiMode: "direct",
      ok: true,
      reads: { count: "same", list: "same", dive: "same", units: "same" },
      dives: mock.account.store.logs.size,
    });
    const sent = directCalls().slice(before);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    // Read-only: no mutation, and the direct rules of PADI (no affiliate-id header or variable).
    for (const r of sent) expect(r.body).not.toMatch(/mutation/i);
    expect(mock.violations).toEqual([]);
    expect(logs).toContain("PADI direct API check: same answers");
  });

  it("does nothing extra without the option", async () => {
    const before = directCalls().length;
    const result = await api("proxy").check();
    expect(result.ok).toBe(true);
    expect(result.otherApi).toBeUndefined();
    expect(directCalls().length).toBe(before);
  });

  it("reports a refusal of the other address without failing the check or switching", async () => {
    const a = api("proxy");
    expect((await a.check()).ok).toBe(true);
    // The direct address refuses twice: the first try and the retry after a token refresh.
    mock.failNext("direct", 401);
    mock.failNext("direct", 401);
    const result = await a.check({ compareModes: true });
    expect(result.ok).toBe(true);
    expect(result.otherApi?.ok).toBe(false);
    expect(result.otherApi?.reads.count).not.toBe("same");
    expect(result.otherApi?.reads.list).toBe("not tried");
    expect(result.otherApi?.error).toBeTruthy();
    // The server still uses the proxy, and it still works.
    expect(a.describeApiMode()).toBe("proxy");
    const before = proxyCalls().length;
    expect(await a.countLogs()).toBe(mock.account.store.logs.size);
    expect(proxyCalls().length).toBe(before + 1);
    mock.failures.clear();
  });

  it("tries the proxy when the server uses the direct address", async () => {
    const result = await api("direct").check({ compareModes: true });
    expect(result).toMatchObject({ ok: true, apiMode: "direct" });
    expect(result.otherApi).toMatchObject({ apiMode: "proxy", ok: true, reads: { count: "same", list: "same", dive: "same", units: "same" } });
    expect(mock.violations).toEqual([]);
  });

  it("compares with the address auto mode uses now", async () => {
    const result = await api("auto").check({ compareModes: true });
    expect(result.apiMode).toBe("auto (proxy)");
    expect(result.otherApi?.apiMode).toBe("direct");
  });
});
