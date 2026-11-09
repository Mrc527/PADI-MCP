import { describe, expect, it } from "vitest";
import { PadiAuthError, PadiSession, REFRESH_MARGIN_MS, type StoredPadiTokens, type TokenSink } from "../../src/padi/session.js";
import { cognitoError, cognitoOk, EMAIL, ENDPOINTS, idToken, json, mockFetch, PASSWORD } from "./padi-fixtures.js";

const T0 = 1_800_000_000_000;

function recordingSink(): TokenSink & { saved: StoredPadiTokens[]; invalidated: string[] } {
  const saved: StoredPadiTokens[] = [];
  const invalidated: string[] = [];
  return { saved, invalidated, save: (t) => void saved.push(t), invalid: (r) => void invalidated.push(r) };
}

describe("PadiSession", () => {
  it("signs in once, saves the first tokens and reuses the ID token", async () => {
    let now = T0;
    const m = mockFetch(() => cognitoOk(idToken({ nowMs: now }), "refresh-1"));
    const sink = recordingSink();
    const s = new PadiSession({ email: EMAIL, password: PASSWORD, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, sink, backoffMs: 0, now: () => now });
    const a = await s.idToken();
    now += 60_000;
    const b = await s.idToken();
    expect(a).toBe(b);
    expect(m.requests).toHaveLength(1);
    expect(sink.saved).toHaveLength(1);
    expect(sink.saved[0]).toMatchObject({ refreshToken: "refresh-1", loginMethod: "cognito" });
    expect((await s.claims()).name).toBe("Alex Tester");
    expect(s.loginMethod).toBe("cognito");
    expect(s.tokenExpiresAt).toBe(T0 + 3_600_000);
  });

  it("refreshes 120 s before expiry with the method that issued the token", async () => {
    let now = T0;
    const m = mockFetch(() => cognitoOk(idToken({ nowMs: now })));
    const sink = recordingSink();
    const s = new PadiSession({
      tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "aud-client" },
      method: "auto",
      endpoints: ENDPOINTS,
      fetch: m.fetch,
      sink,
      backoffMs: 0,
      now: () => now,
    });
    await s.idToken();
    expect((m.requests[0]!.json as { AuthFlow: string }).AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    now += 3_600_000 - REFRESH_MARGIN_MS - 1000;
    await s.idToken();
    expect(m.requests).toHaveLength(1);
    now += 2000;
    await s.idToken();
    expect(m.requests).toHaveLength(2);
    // A Cognito refresh keeps the refresh token: nothing to save.
    expect(sink.saved).toHaveLength(0);
  });

  it("keeps a just-renewed short-lived token instead of refreshing on every call", async () => {
    let now = T0;
    // A token that already looks close to expiry (clock skew or a short lifetime).
    const m = mockFetch(() => cognitoOk(idToken({ nowMs: now, lifetimeS: 90 })));
    const s = new PadiSession({ tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c" }, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, backoffMs: 0, now: () => now });
    const a = await s.idToken();
    now += 10_000;
    expect(await s.idToken()).toBe(a);
    await s.claims();
    expect(m.requests).toHaveLength(1);
    // After the short grace period it renews again.
    now += 30_000;
    await s.idToken();
    expect(m.requests).toHaveLength(2);
  });

  it("shares one refresh between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mockFetch(async () => {
      await gate;
      return cognitoOk(idToken({ nowMs: T0 }));
    });
    const s = new PadiSession({ tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c" }, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, backoffMs: 0, now: () => T0 });
    const all = Promise.all([s.idToken(), s.idToken(), s.claims(), s.refreshNow()]);
    release();
    const [a, b, , d] = await all;
    expect(a).toBe(b);
    expect(a).toBe(d);
    expect(m.requests).toHaveLength(1);
  });

  it("refreshNow skips the refresh when another caller already replaced the refused token", async () => {
    let n = 0;
    const m = mockFetch(() => cognitoOk(idToken({ nowMs: T0, extra: { n: ++n } })));
    const s = new PadiSession({ tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c" }, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, backoffMs: 0, now: () => T0 });
    const first = await s.idToken();
    const second = await s.refreshNow(first);
    expect(second).not.toBe(first);
    expect(await s.refreshNow(first)).toBe(second);
    expect(m.requests).toHaveLength(2);
  });

  it("saves a rotated refresh token from the PADI auth API", async () => {
    const m = mockFetch(() => json({ idToken: idToken({ nowMs: T0 }), refreshToken: "rotated" }));
    const sink = recordingSink();
    const s = new PadiSession({ tokens: { refreshToken: "old", loginMethod: "padi", clientId: "c" }, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, sink, backoffMs: 0, now: () => T0 });
    await s.idToken();
    expect(m.requests[0]!.url).toBe(`${ENDPOINTS.authUrl}/oauth/refresh`);
    expect(sink.saved).toEqual([expect.objectContaining({ refreshToken: "rotated", loginMethod: "padi" })]);
    expect(s.storedTokens?.refreshToken).toBe("rotated");
  });

  it("signs in again when the refresh token died and a password is known", async () => {
    const m = mockFetch((req) =>
      (req.json as { AuthFlow: string }).AuthFlow === "REFRESH_TOKEN_AUTH" ? cognitoError("NotAuthorizedException", "Refresh Token has expired") : cognitoOk(idToken({ nowMs: T0 }), "fresh"),
    );
    const sink = recordingSink();
    const s = new PadiSession({
      email: EMAIL,
      password: PASSWORD,
      tokens: { refreshToken: "dead", loginMethod: "cognito", clientId: "c" },
      method: "auto",
      endpoints: ENDPOINTS,
      fetch: m.fetch,
      sink,
      backoffMs: 0,
      now: () => T0,
    });
    await s.idToken();
    expect(m.requests.map((r) => (r.json as { AuthFlow: string }).AuthFlow)).toEqual(["REFRESH_TOKEN_AUTH", "USER_PASSWORD_AUTH"]);
    expect(sink.saved.map((t) => t.refreshToken)).toEqual(["fresh"]);
    expect(sink.invalidated).toEqual([]);
  });

  it("marks the connection invalid when the refresh token died and there is no password", async () => {
    const m = mockFetch(() => cognitoError("NotAuthorizedException", "Invalid Refresh Token"));
    const sink = recordingSink();
    const s = new PadiSession({ tokens: { refreshToken: "dead", loginMethod: "cognito", clientId: "c" }, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, sink, backoffMs: 0, now: () => T0 });
    const err = await s.idToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PadiAuthError);
    expect((err as PadiAuthError).code).toBe("expired");
    expect(sink.invalidated).toHaveLength(1);
    // Later calls fail at once, without asking PADI again.
    await expect(s.idToken()).rejects.toBeInstanceOf(PadiAuthError);
    expect(m.requests).toHaveLength(1);
    expect(sink.invalidated).toHaveLength(1);
  });

  it("never tries a refused password again", async () => {
    const m = mockFetch(() => cognitoError("NotAuthorizedException", "Incorrect username or password."));
    const s = new PadiSession({ email: EMAIL, password: "wrong-password", method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, backoffMs: 0, now: () => T0 });
    for (let i = 0; i < 3; i++) {
      const err = await s.idToken().catch((e: unknown) => e);
      expect((err as PadiAuthError).code).toBe("bad_credentials");
    }
    expect(m.requests).toHaveLength(1);
  });

  it("keeps trying after a network problem (it is not the user's fault)", async () => {
    let fail = true;
    const m = mockFetch(() => (fail ? json({ message: "down" }, 500) : cognitoOk(idToken({ nowMs: T0 }))));
    const s = new PadiSession({ tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c" }, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, backoffMs: 0, now: () => T0 });
    expect(((await s.idToken().catch((e: unknown) => e)) as PadiAuthError).code).toBe("network");
    fail = false;
    expect(await s.idToken()).toMatch(/^eyJ/);
  });

  it("uses a stored ID token that is still valid, without a request", async () => {
    const token = idToken({ nowMs: T0 });
    const m = mockFetch(() => {
      throw new Error("no request expected");
    });
    const s = new PadiSession({
      tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c", idToken: token, idTokenExpiresAt: T0 + 3_600_000 },
      method: "auto",
      endpoints: ENDPOINTS,
      fetch: m.fetch,
      now: () => T0 + 1000,
    });
    expect(await s.idToken()).toBe(token);
    expect((await s.claims()).affiliateId).toBe("10000001");
    expect(m.requests).toHaveLength(0);
  });

  it("fails clearly without any way to sign in", async () => {
    const s = new PadiSession({ method: "auto", endpoints: ENDPOINTS, fetch: mockFetch(() => json({})).fetch });
    expect(((await s.idToken().catch((e: unknown) => e)) as PadiAuthError).code).toBe("expired");
  });
});
