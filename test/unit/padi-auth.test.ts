import { describe, expect, it } from "vitest";
import { PadiAuthError, refresh, signIn, type StoredPadiTokens } from "../../src/padi/auth.js";
import { failedBeforeSending, PadiHttpError, padiFetch } from "../../src/padi/http.js";
import { claimsFromPayload, decodeJwt, jwtAudience, jwtExpiresAt } from "../../src/padi/jwt.js";
import { maskEmails, redact, redactForLog } from "../../src/util/errors.js";
import { AFFILIATE_ID, cognitoError, cognitoOk, EMAIL, ENDPOINTS, idToken, json, mockFetch, PASSWORD, refused, reset } from "./padi-fixtures.js";

const opts = (fetch: typeof globalThis.fetch) => ({ endpoints: ENDPOINTS, fetch, backoffMs: 0 });

async function authError(p: Promise<unknown>): Promise<PadiAuthError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(PadiAuthError);
    return error as PadiAuthError;
  }
  throw new Error("expected a PadiAuthError");
}

describe("jwt", () => {
  it("reads the claims PADI puts into the ID token", () => {
    const token = idToken({ nowMs: 1_700_000_000_000 });
    const payload = decodeJwt(token)!;
    expect(jwtExpiresAt(payload)).toBe(1_700_003_600_000);
    expect(jwtAudience(payload)).toBe(ENDPOINTS.clientId);
    expect(claimsFromPayload(payload)).toEqual({ affiliateId: AFFILIATE_ID, email: EMAIL, name: "Alex Tester", isPro: false, sub: "00000000-0000-4000-8000-000000000001" });
    expect(claimsFromPayload(decodeJwt(idToken({ typeId: "3" }))!)?.isPro).toBe(true);
    expect(claimsFromPayload(decodeJwt(idToken({ affiliateId: null }))!)).toBeUndefined();
    expect(claimsFromPayload(decodeJwt(idToken({ affiliateId: "12; DROP" }))!)).toBeUndefined();
  });

  it("refuses text that is not a JWT", () => {
    expect(decodeJwt("abc")).toBeUndefined();
    expect(decodeJwt("a.b.c")).toBeUndefined();
    expect(decodeJwt(`x.${Buffer.from("[1]").toString("base64url")}.y`)).toBeUndefined();
  });
});

describe("signIn with Cognito", () => {
  it("sends USER_PASSWORD_AUTH with the e-mail lowercased", async () => {
    const token = idToken();
    const m = mockFetch(() => cognitoOk(token, "refresh-token-1"));
    const result = await signIn("  Alex.Tester@Example.COM ", PASSWORD, { method: "auto", ...opts(m.fetch) });
    expect(m.requests).toHaveLength(1);
    const req = m.requests[0]!;
    expect(req.url).toBe(ENDPOINTS.cognitoUrl);
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(req.headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(req.json).toEqual({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: ENDPOINTS.clientId, AuthParameters: { USERNAME: EMAIL, PASSWORD } });
    expect(result.tokens).toMatchObject({ refreshToken: "refresh-token-1", loginMethod: "cognito", clientId: ENDPOINTS.clientId, idToken: token });
    expect(result.tokens.idTokenExpiresAt).toBe(jwtExpiresAt(decodeJwt(token)!));
    expect(result.claims.affiliateId).toBe(AFFILIATE_ID);
  });

  it("never retries or falls back after wrong credentials", async () => {
    const m = mockFetch(() => cognitoError("NotAuthorizedException", "Incorrect username or password."));
    const err = await authError(signIn(EMAIL, "wrong", { method: "auto", ...opts(m.fetch) }));
    expect(err.code).toBe("bad_credentials");
    expect(err.message).not.toContain("wrong");
    expect(m.requests).toHaveLength(1);
  });

  it("maps the other Cognito answers", async () => {
    const cases: Array<[Response, string, RegExp]> = [
      [cognitoError("UserNotConfirmedException", "User is not confirmed."), "not_confirmed", /not confirmed/],
      [cognitoError("PasswordResetRequiredException", "Password reset required for the user"), "password_reset", /reset/],
      [cognitoError("NotAuthorizedException", "Password attempts exceeded"), "bad_credentials", /too many failed/i],
      [cognitoError("UserNotFoundException", "User does not exist."), "bad_credentials", /e-mail or password/],
      [json({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "x", ChallengeParameters: {} }), "challenge", /extra sign-in code/],
      [json({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "x", ChallengeParameters: {} }), "challenge", /new password/],
    ];
    for (const [response, code, message] of cases) {
      const m = mockFetch(() => response.clone());
      const err = await authError(signIn(EMAIL, PASSWORD, { method: "auto", ...opts(m.fetch) }));
      expect(err.code).toBe(code);
      expect(err.message).toMatch(message);
      // A "the user must act" answer never falls back to the PADI auth API.
      expect(m.requests).toHaveLength(1);
    }
  });

  it("refuses a token without a PADI affiliate id", async () => {
    const m = mockFetch(() => cognitoOk(idToken({ affiliateId: null }), "rt"));
    const err = await authError(signIn(EMAIL, PASSWORD, { method: "cognito", ...opts(m.fetch) }));
    expect(err.message).toMatch(/affiliate id/);
  });
});

describe("signIn fallback and the PADI auth API", () => {
  it("falls back to the PADI auth API when Cognito fails for another reason", async () => {
    const token = idToken();
    const m = mockFetch((req) =>
      req.url === ENDPOINTS.cognitoUrl
        ? cognitoError("InvalidParameterException", "USER_PASSWORD_AUTH flow not enabled for this client")
        : json({ tokens: { idToken: token, accessToken: token, refreshToken: "padi-refresh" } }),
    );
    const result = await signIn("ALEX.tester@example.com", PASSWORD, { method: "auto", ...opts(m.fetch) });
    expect(m.requests.map((r) => r.url)).toEqual([ENDPOINTS.cognitoUrl, `${ENDPOINTS.authUrl}/oauth/login`]);
    expect(m.requests[1]!.json).toEqual({ username: EMAIL, password: PASSWORD, clientId: ENDPOINTS.clientId, extraData: "" });
    expect(result.tokens).toMatchObject({ loginMethod: "padi", refreshToken: "padi-refresh" });
  });

  it("falls back when Cognito cannot be reached", async () => {
    const token = idToken();
    const m = mockFetch((req) => {
      if (req.url === ENDPOINTS.cognitoUrl) throw reset();
      return json({ tokens: { idToken: token, refreshToken: "padi-refresh" } });
    });
    const result = await signIn(EMAIL, PASSWORD, { method: "auto", ...opts(m.fetch) });
    expect(result.tokens.loginMethod).toBe("padi");
  });

  it("maps PADI auth API errors (plain text or JSON)", async () => {
    for (const body of ["Incorrect username or password.", { message: "Incorrect username or password." }]) {
      const m = mockFetch(() => json(body, 400));
      const err = await authError(signIn(EMAIL, PASSWORD, { method: "padi", ...opts(m.fetch) }));
      expect(err.code).toBe("bad_credentials");
      expect(m.requests).toHaveLength(1);
    }
    const unconfirmed = mockFetch(() => json("User is not confirmed.", 400));
    expect((await authError(signIn(EMAIL, PASSWORD, { method: "padi", ...opts(unconfirmed.fetch) }))).code).toBe("not_confirmed");
    const down = mockFetch(() => json("oops", 500));
    expect((await authError(signIn(EMAIL, PASSWORD, { method: "padi", ...opts(down.fetch) }))).code).toBe("network");
    // A sign-in is never sent twice after a server error (it could count as a failed attempt).
    expect(down.requests).toHaveLength(1);
  });

  it("reports a network problem without details", async () => {
    const m = mockFetch(() => {
      throw refused();
    });
    const err = await authError(signIn(EMAIL, PASSWORD, { method: "cognito", ...opts(m.fetch) }));
    expect(err.code).toBe("network");
    // Nothing was sent, so it was tried 3 times.
    expect(m.requests).toHaveLength(3);
  });

  it("asks for both e-mail and password", async () => {
    const m = mockFetch(() => cognitoOk(idToken(), "rt"));
    expect((await authError(signIn("", PASSWORD, { method: "auto", ...opts(m.fetch) }))).code).toBe("bad_credentials");
    expect(m.requests).toHaveLength(0);
  });
});

describe("refresh", () => {
  const cognitoTokens: StoredPadiTokens = { refreshToken: "stored-refresh", loginMethod: "cognito", clientId: "aud-client" };

  it("refreshes through Cognito and keeps the stored refresh token", async () => {
    const token = idToken();
    const m = mockFetch(() => cognitoOk(token));
    const result = await refresh(cognitoTokens, opts(m.fetch));
    expect(m.requests[0]!.json).toEqual({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: "aud-client", AuthParameters: { REFRESH_TOKEN: "stored-refresh" } });
    expect(result.tokens).toMatchObject({ refreshToken: "stored-refresh", loginMethod: "cognito", idToken: token });
  });

  it("reports an invalid or expired refresh token as expired", async () => {
    for (const message of ["Invalid Refresh Token", "Refresh Token has expired"]) {
      const m = mockFetch(() => cognitoError("NotAuthorizedException", message));
      expect((await authError(refresh(cognitoTokens, opts(m.fetch)))).code).toBe("expired");
    }
  });

  it("refreshes through the PADI auth API, which may rotate the refresh token", async () => {
    const token = idToken();
    const m = mockFetch(() => json({ idToken: token, accessToken: token, refreshToken: "rotated" }));
    const result = await refresh({ refreshToken: "old", loginMethod: "padi", clientId: "aud-client", idToken: "old-id" }, opts(m.fetch));
    expect(m.requests[0]!.url).toBe(`${ENDPOINTS.authUrl}/oauth/refresh`);
    expect(m.requests[0]!.json).toEqual({ refreshToken: "old", clientId: "aud-client", idToken: "old-id" });
    expect(result.tokens.refreshToken).toBe("rotated");
    const same = mockFetch(() => json({ idToken: token }));
    expect((await refresh({ refreshToken: "old", loginMethod: "padi", clientId: "c" }, opts(same.fetch))).tokens.refreshToken).toBe("old");
    const dead = mockFetch(() => json("Invalid refresh token", 401));
    expect((await authError(refresh({ refreshToken: "old", loginMethod: "padi", clientId: "c" }, opts(dead.fetch)))).code).toBe("expired");
  });
});

describe("padiFetch", () => {
  const noSleep = { backoffMs: 0 };

  it("tries a read 3 times on 5xx and returns the last answer", async () => {
    const m = mockFetch(() => json({}, 503));
    const res = await padiFetch("https://x.test/", { method: "GET" }, { fetch: m.fetch, ...noSleep });
    expect(res.status).toBe(503);
    expect(m.requests).toHaveLength(3);
  });

  it("never sends a write twice after it may have reached the server", async () => {
    const m = mockFetch(() => json({}, 502));
    const res = await padiFetch("https://x.test/", { method: "POST" }, { fetch: m.fetch, idempotent: false, ...noSleep });
    expect(res.status).toBe(502);
    expect(m.requests).toHaveLength(1);
    const broken = mockFetch(() => {
      throw reset();
    });
    const err = await padiFetch("https://x.test/", { method: "POST" }, { fetch: broken.fetch, idempotent: false, ...noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PadiHttpError);
    expect((err as PadiHttpError).sent).toBe(true);
    expect(broken.requests).toHaveLength(1);
  });

  it("tries a write again on 429 and when nothing was sent", async () => {
    const m = mockFetch((_req, i) => (i === 0 ? json({}, 429, { "retry-after": "0" }) : json({ ok: true })));
    expect((await padiFetch("https://x.test/", { method: "POST" }, { fetch: m.fetch, idempotent: false, ...noSleep })).status).toBe(200);
    expect(m.requests).toHaveLength(2);
    const r = mockFetch((_req, i) => {
      if (i === 0) throw refused();
      return json({ ok: true });
    });
    expect((await padiFetch("https://x.test/", { method: "POST" }, { fetch: r.fetch, idempotent: false, ...noSleep })).status).toBe(200);
    expect(failedBeforeSending(refused())).toBe(true);
    expect(failedBeforeSending(reset())).toBe(false);
  });

  it("waits as long as Retry-After says (capped)", async () => {
    const waits: number[] = [];
    const m = mockFetch((_req, i) => (i === 0 ? json({}, 429, { "retry-after": "2" }) : i === 1 ? json({}, 429, { "retry-after": "9999" }) : json({})));
    await padiFetch("https://x.test/", {}, { fetch: m.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([2000, 10000]);
  });

  it("stops a request that takes too long", async () => {
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const err = await padiFetch("https://x.test/", { method: "POST" }, { fetch: slow, timeoutMs: 20, idempotent: false, what: "The PADI logbook" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PadiHttpError);
    expect((err as PadiHttpError).kind).toBe("timeout");
    expect((err as Error).message).toMatch(/The PADI logbook did not answer within 0 s/);
  });
});

describe("redaction", () => {
  it("masks tokens, passwords and secrets", () => {
    const token = idToken();
    const text = `failed: Bearer ${token} body {"password":"hunter2-pw","refreshToken":"abc.def","AuthParameters":{"REFRESH_TOKEN":"zzz"}} url ?refresh_token=xyz&x=1 raw ${token}`;
    const out = redact(text, [PASSWORD]);
    expect(out).not.toContain(token);
    expect(out).not.toContain("hunter2-pw");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain('"zzz"');
    expect(out).not.toContain("xyz");
    expect(out).toContain("&x=1");
    expect(redact(`pw ${PASSWORD}`, [PASSWORD])).toBe("pw ***");
  });

  it("masks e-mail addresses in log lines", () => {
    expect(maskEmails("user alex.tester@example.com failed")).toBe("user a***@example.com failed");
    expect(redactForLog(`${EMAIL} Bearer abcdefghijkl`, [])).toBe("a***@example.com Bearer ***");
  });
});
