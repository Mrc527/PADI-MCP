/**
 * Shared helpers for the PADI client tests: fake ID tokens and a scripted fetch. Invented data
 * only; no request ever leaves the process.
 */

import { DEFAULT_ENDPOINTS, type PadiEndpoints } from "../../src/padi/endpoints.js";

export const ENDPOINTS: PadiEndpoints = {
  ...DEFAULT_ENDPOINTS,
  cognitoUrl: "https://cognito.test/",
  authUrl: "https://auth.test/auth/api",
  logbookUrl: "https://proxy.test/api/Logbook",
  directUrl: "https://direct.test/v1/graphql",
  instructorUrl: "https://proxy.test/api/Logbook/instructor",
  directInstructorUrl: "https://service.test/instructor",
  ecardUrl: "https://ecard.test/api/eCard",
  imagesUrl: "https://images.test/api/Image",
  clientId: "testclient123",
};

export const AFFILIATE_ID = "10000001";
export const EMAIL = "alex.tester@example.com";
export const PASSWORD = "not-a-real-password";

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned JWT shaped like a PADI ID token. */
export function idToken(opts: { nowMs?: number; lifetimeS?: number; affiliateId?: string | null; typeId?: string; extra?: Record<string, unknown> } = {}): string {
  const iat = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const payload: Record<string, unknown> = {
    sub: "00000000-0000-4000-8000-000000000001",
    aud: ENDPOINTS.clientId,
    email: EMAIL,
    given_name: "Alex",
    family_name: "Tester",
    "custom:affiliate_type_id": opts.typeId ?? "1",
    iat,
    exp: iat + (opts.lifetimeS ?? 3600),
    ...opts.extra,
  };
  if (opts.affiliateId !== null) payload["custom:affiliate_id"] = opts.affiliateId ?? AFFILIATE_ID;
  return `${b64({ alg: "RS256", kid: "test" })}.${b64(payload)}.c2lnbmF0dXJl`;
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  json: unknown;
}

export type Responder = (req: Recorded, index: number) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch that records every request and answers with the responder. */
export function mockFetch(responder: Responder): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === "string" ? init.body : "";
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    const req: Recorded = { url: String(input), method: (init.method ?? "GET").toUpperCase(), headers, body, json: parsed };
    requests.push(req);
    return responder(req, requests.length - 1);
  };
  return { fetch: fn as typeof fetch, requests };
}

/** A Cognito InitiateAuth success. */
export function cognitoOk(token: string, refreshToken?: string): Response {
  return json({
    AuthenticationResult: { AccessToken: "access-token-value", ExpiresIn: 3600, IdToken: token, TokenType: "Bearer", ...(refreshToken ? { RefreshToken: refreshToken } : {}) },
    ChallengeParameters: {},
  });
}

export function cognitoError(type: string, message: string, status = 400): Response {
  return json({ __type: type, message }, status, { "content-type": "application/x-amz-json-1.1" });
}

/** A connection error before anything was sent. */
export function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

/** A connection error after the request may have been sent. */
export function reset(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
}
