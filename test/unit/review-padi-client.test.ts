/**
 * Review tests for rules of the PADI client that no other test guarded:
 * - a wrong password is final also when Cognito failed first and auto mode fell back to the PADI
 *   auth API (else the session sends the wrong password again on every call: account lockout);
 * - a request that timed out is never sent again when it is a write (a dive saved twice);
 * - a busy or failing PADI auth API refresh is not an expired sign-in;
 * - auto mode switches to the direct API only after two proxy failures in a row.
 *
 * Invented data only; no request ever leaves the process.
 */
import { describe, expect, it } from "vitest";
import { PadiAuthError, refresh, signIn } from "../../src/padi/auth.js";
import { listDocument } from "../../src/padi/documents.js";
import { GraphqlClient } from "../../src/padi/graphql.js";
import { PadiHttpError, padiFetch } from "../../src/padi/http.js";
import { PadiSession, type StoredPadiTokens, type TokenSink } from "../../src/padi/session.js";
import { UnconfirmedWriteError } from "../../src/util/errors.js";
import { cognitoError, EMAIL, ENDPOINTS, idToken, json, mockFetch, PASSWORD, refused, reset, type Recorded, type Responder } from "./padi-fixtures.js";

const T0 = 1_800_000_000_000;
const LOGIN_URL = `${ENDPOINTS.authUrl}/oauth/login`;
const REFRESH_URL = `${ENDPOINTS.authUrl}/oauth/refresh`;

const opts = (fetch: typeof globalThis.fetch) => ({ endpoints: ENDPOINTS, fetch, backoffMs: 0 });

function recordingSink(): TokenSink & { saved: StoredPadiTokens[]; invalidated: string[] } {
  const saved: StoredPadiTokens[] = [];
  const invalidated: string[] = [];
  return { saved, invalidated, save: (t) => void saved.push(t), invalid: (r) => void invalidated.push(r) };
}

/** A fetch that never answers: it fails only when the request is stopped (the timeout). */
function never(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fn = (async (_url: string, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  return { fetch: fn, calls: () => calls };
}

describe("auto sign-in: a wrong password after the fallback is final", () => {
  /** Cognito fails in a way that is not the user's fault; the PADI auth API refuses the password. */
  const cases: Array<[string, (req: Recorded) => Response]> = [
    [
      "Cognito connection broken",
      () => {
        throw reset();
      },
    ],
    [
      "Cognito cannot be reached",
      () => {
        throw refused();
      },
    ],
    ["Cognito answers HTTP 500", () => cognitoError("InternalErrorException", "Internal server error", 500)],
    ["Cognito refuses the flow", () => cognitoError("InvalidParameterException", "USER_PASSWORD_AUTH flow not enabled for this client")],
  ];

  for (const [name, cognito] of cases) {
    it(`${name}, then "Incorrect username or password." from the PADI auth API`, async () => {
      const responder: Responder = (req) => (req.url === ENDPOINTS.cognitoUrl ? cognito(req) : json("Incorrect username or password.", 400));
      const m = mockFetch(responder);
      const err = await signIn(EMAIL, PASSWORD, { method: "auto", ...opts(m.fetch) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PadiAuthError);
      expect((err as PadiAuthError).code).toBe("bad_credentials");
      expect(m.requests.filter((r) => r.url === LOGIN_URL)).toHaveLength(1);

      // A session (single-user mode with PADI_PASSWORD) never sends that password again.
      const s2 = mockFetch(responder);
      const session = new PadiSession({ email: EMAIL, password: PASSWORD, method: "auto", endpoints: ENDPOINTS, fetch: s2.fetch, backoffMs: 0, now: () => T0 });
      for (let i = 0; i < 3; i++) {
        const again = await session.idToken().catch((e: unknown) => e);
        expect((again as PadiAuthError).code, `call ${i + 1}`).toBe("bad_credentials");
      }
      expect(s2.requests.filter((r) => r.url === LOGIN_URL)).toHaveLength(1);
      const cognitoTries = s2.requests.filter((r) => r.url === ENDPOINTS.cognitoUrl).length;
      // Cognito too was asked during the first call only (3 tries when nothing was sent).
      expect(cognitoTries).toBe(m.requests.filter((r) => r.url === ENDPOINTS.cognitoUrl).length);
    });
  }

  it("a server error at the PADI auth API is not final: the next call tries again", async () => {
    let down = true;
    const m = mockFetch((req) => {
      if (req.url === ENDPOINTS.cognitoUrl) throw reset();
      return down ? json("oops", 503) : json({ tokens: { idToken: idToken({ nowMs: T0 }), refreshToken: "padi-refresh" } });
    });
    const session = new PadiSession({ email: EMAIL, password: PASSWORD, method: "auto", endpoints: ENDPOINTS, fetch: m.fetch, backoffMs: 0, now: () => T0 });
    const err = await session.idToken().catch((e: unknown) => e);
    expect((err as PadiAuthError).code).not.toBe("bad_credentials");
    down = false;
    expect(await session.idToken()).toMatch(/^eyJ/);
    expect(m.requests.filter((r) => r.url === LOGIN_URL)).toHaveLength(2);
  });
});

describe("timeouts: a write is never sent again", () => {
  it("padiFetch sends a timed-out write once, and a timed-out read 3 times", async () => {
    const write = never();
    const err = await padiFetch("https://x.test/", { method: "POST" }, { fetch: write.fetch, timeoutMs: 20, idempotent: false, backoffMs: 0, what: "The PADI logbook" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PadiHttpError);
    expect((err as PadiHttpError).kind).toBe("timeout");
    expect((err as PadiHttpError).sent).toBe(true);
    expect(write.calls()).toBe(1);

    // A POST is a write unless the caller says otherwise.
    const post = never();
    await expect(padiFetch("https://x.test/", { method: "POST" }, { fetch: post.fetch, timeoutMs: 20, backoffMs: 0 })).rejects.toMatchObject({ kind: "timeout" });
    expect(post.calls()).toBe(1);

    const read = never();
    await expect(padiFetch("https://x.test/", { method: "GET" }, { fetch: read.fetch, timeoutMs: 20, backoffMs: 0 })).rejects.toMatchObject({ kind: "timeout" });
    expect(read.calls()).toBe(3);
  });

  it("a GraphQL write that times out is sent once, is reported as maybe saved, and does not switch the API", async () => {
    for (const mode of ["proxy", "direct", "auto"] as const) {
      const slow = never();
      const client = new GraphqlClient({ session: storedSession(slow.fetch), endpoints: ENDPOINTS, mode, fetch: slow.fetch, timeoutMs: 20, backoffMs: 0 });
      const err = await client.request(list, { write: true }).catch((e: unknown) => e);
      expect(err, mode).toBeInstanceOf(UnconfirmedWriteError);
      expect(((err as Error).cause as PadiHttpError).kind).toBe("timeout");
      expect(slow.calls(), mode).toBe(1);
      expect(client.mode).toBe(mode === "direct" ? "direct" : "proxy");
    }
  });
});

describe("PADI auth API refresh: busy or failing is not expired", () => {
  const padiTokens: StoredPadiTokens = { refreshToken: "padi-rt", loginMethod: "padi", clientId: "c" };

  it("refresh() does not report HTTP 429 or 5xx as an expired sign-in", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const m = mockFetch(() => json({ message: "busy" }, status));
      const err = await refresh(padiTokens, opts(m.fetch)).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(PadiAuthError);
      expect((err as PadiAuthError).code, String(status)).not.toBe("expired");
    }
    // A 4xx is a dead refresh token.
    for (const status of [400, 401, 403]) {
      const m = mockFetch(() => json("Invalid refresh token", status));
      expect(((await refresh(padiTokens, opts(m.fetch)).catch((e: unknown) => e)) as PadiAuthError).code, String(status)).toBe("expired");
    }
  });

  it("a session keeps its connection when the refresh gets HTTP 503, and works again later", async () => {
    for (const password of [undefined, PASSWORD]) {
      let down = true;
      const m = mockFetch((req) => {
        if (req.url !== REFRESH_URL) return json({ message: "unexpected request" }, 418);
        return down ? json({ message: "Service Unavailable" }, 503) : json({ idToken: idToken({ nowMs: T0 }) });
      });
      const sink = recordingSink();
      const session = new PadiSession({
        ...(password ? { email: EMAIL, password } : {}),
        tokens: padiTokens,
        method: "auto",
        endpoints: ENDPOINTS,
        fetch: m.fetch,
        sink,
        backoffMs: 0,
        now: () => T0,
      });
      const err = await session.idToken().catch((e: unknown) => e);
      expect((err as PadiAuthError).code).toBe("network");
      expect(sink.invalidated).toEqual([]);
      // With a password, the session does not sign in again either (no extra password attempt).
      expect(m.requests.every((r) => r.url === REFRESH_URL)).toBe(true);
      down = false;
      expect(await session.idToken()).toMatch(/^eyJ/);
      expect(sink.invalidated).toEqual([]);
      expect(session.storedTokens?.refreshToken).toBe("padi-rt");
    }
  });
});

describe("auto mode: two proxy failures in a row", () => {
  it("a good proxy answer in between resets the count", async () => {
    let n = 0;
    const m = mockFetch((req) => (req.url === ENDPOINTS.logbookUrl && ++n % 2 === 1 ? new Response("gone", { status: 404 }) : json({ data: { logbook_logs: [] } })));
    const log: string[] = [];
    const c = new GraphqlClient({ session: storedSession(m.fetch), endpoints: ENDPOINTS, mode: "auto", fetch: m.fetch, backoffMs: 0, log: (l) => void log.push(l) });
    for (let i = 0; i < 4; i++) await c.request(list, { write: false });
    expect(c.mode).toBe("proxy");
    expect(m.requests).toHaveLength(8);
    expect(m.requests.every((r) => r.url === ENDPOINTS.logbookUrl)).toBe(true);
    expect(log).toEqual([]);
  });

  it("a GraphQL error answered with HTTP 200 by the proxy also resets the count", async () => {
    let n = 0;
    const m = mockFetch((req) => {
      if (req.url !== ENDPOINTS.logbookUrl) return json({ data: { logbook_logs: [] } });
      n++;
      if (n === 1 || n === 3) return new Response("gone", { status: 404 });
      if (n === 2) return json({ errors: [{ message: "field 'nope' not found in type: 'logbook_logs'", extensions: { code: "validation-failed" } }] });
      return json({ data: { logbook_logs: [] } });
    });
    const c = new GraphqlClient({ session: storedSession(m.fetch), endpoints: ENDPOINTS, mode: "auto", fetch: m.fetch, backoffMs: 0 });
    await expect(c.request(list, { write: false })).rejects.toThrow();
    await c.request(list, { write: false });
    expect(c.mode).toBe("proxy");
    expect(m.requests.every((r) => r.url === ENDPOINTS.logbookUrl)).toBe(true);
  });

  it("two failures in a row still switch (the control case)", async () => {
    const m = mockFetch((req) => (req.url === ENDPOINTS.logbookUrl ? new Response("gone", { status: 404 }) : json({ data: { logbook_logs: [] } })));
    const c = new GraphqlClient({ session: storedSession(m.fetch), endpoints: ENDPOINTS, mode: "auto", fetch: m.fetch, backoffMs: 0 });
    await c.request(list, { write: false });
    expect(c.mode).toBe("direct");
  });
});

const list = (mode: "proxy" | "direct", aff: string) => listDocument(mode, aff, { limit: 5, offset: 0, selection: "summary" });

/** A session with a valid stored ID token (no sign-in request). */
function storedSession(fetch: typeof globalThis.fetch): PadiSession {
  return new PadiSession({
    tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c", idToken: idToken({ nowMs: T0 }), idTokenExpiresAt: T0 + 3_600_000 },
    method: "auto",
    endpoints: ENDPOINTS,
    fetch,
    backoffMs: 0,
    now: () => T0 + 1000,
  });
}
