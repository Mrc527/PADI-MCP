/**
 * Sign-in to PADI.
 *
 * Default method: AWS Cognito InitiateAuth with USER_PASSWORD_AUTH on the public PADI app client
 * (no client secret), the e-mail lowercased. Fallback: the PADI auth API (/oauth/login). With
 * method "auto", the PADI auth API is tried only when Cognito fails for a reason other than wrong
 * credentials: a wrong e-mail or password is never retried (that could lock the account).
 *
 * The bearer token for every PADI API is the ID token (lifetime 3600 s). The refresh token is the
 * only thing that is stored.
 */

import { UserFacingError } from "../util/errors.js";
import type { PadiEndpoints } from "./endpoints.js";
import { padiFetch, parseJson, PadiHttpError, readText } from "./http.js";
import { claimsFromPayload, decodeJwt, jwtAudience, jwtExpiresAt } from "./jwt.js";

export type LoginMethod = "cognito" | "padi";

/** What is kept between runs (encrypted in the web service, a 0600 file or memory locally). */
export interface StoredPadiTokens {
  refreshToken: string;
  /** The method that issued the refresh token (refresh goes the same way). */
  loginMethod: LoginMethod;
  /** The app client the tokens were issued for (the token's "aud"). */
  clientId: string;
  idToken?: string;
  /** Epoch milliseconds. */
  idTokenExpiresAt?: number;
}

/** What the server reads from the ID token. Never taken from user input. */
export interface PadiClaims {
  /** custom:affiliate_id, a numeric string: the tenant key of every logbook query. */
  affiliateId: string;
  email?: string;
  /** given_name and family_name. */
  name?: string;
  /** custom:affiliate_type_id is "2" or "3". */
  isPro: boolean;
  sub?: string;
}

export interface SignInResult {
  tokens: StoredPadiTokens & { idToken: string; idTokenExpiresAt: number };
  claims: PadiClaims;
}

export type PadiAuthErrorCode = "bad_credentials" | "challenge" | "expired" | "not_confirmed" | "password_reset" | "network" | "unknown";

/**
 * Why PADI refused a password that may be right: the account is blocked for now after too many
 * failed attempts, or disabled. PADI reports both as "wrong e-mail or password" (code
 * bad_credentials), so the code alone cannot tell them apart.
 */
export type PadiAuthRefusal = "locked" | "disabled";

/** A sign-in or refresh problem. The message is safe to show (never contains a secret). */
export class PadiAuthError extends UserFacingError {
  readonly code: PadiAuthErrorCode;
  readonly refusal?: PadiAuthRefusal;

  constructor(code: PadiAuthErrorCode, message: string, options?: { cause?: unknown; refusal?: PadiAuthRefusal }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PadiAuthError";
    this.code = code;
    if (options?.refusal) this.refusal = options.refusal;
  }
}

export interface AuthOptions {
  endpoints: PadiEndpoints;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Backoff of the HTTP layer (tests use 0). */
  backoffMs?: number;
  /** The clock (epoch ms), for tests. */
  now?: () => number;
}

/** Codes that mean "the user must act": never try another method or sign in again by itself. */
const FINAL_CODES: ReadonlySet<PadiAuthErrorCode> = new Set(["bad_credentials", "challenge", "not_confirmed", "password_reset"]);

/** ID token lifetime when PADI does not say (3600 s on every token seen). */
const DEFAULT_LIFETIME_S = 3600;

const MSG = {
  badCredentials: "PADI did not accept the e-mail or password. Check them and try again (use the e-mail and password you use on padi.com).",
  locked: "PADI blocked sign-in for now after too many failed attempts. Wait a while, then try again.",
  disabled: "PADI says this account is disabled. Contact PADI.",
  notConfirmed: "This PADI account is not confirmed yet. Confirm it with the e-mail PADI sent, then try again.",
  passwordReset: "PADI asks you to reset your password. Reset it at account.padi.com, then sign in here with the new password.",
  newPassword: "PADI asks you to set a new password. Sign in once at account.padi.com, then sign in here with the new password.",
  mfa: "PADI asks for an extra sign-in code (multi-factor sign-in). This server cannot do that step.",
  expired: "Your PADI sign-in expired. Sign in to PADI again.",
  network: "Could not reach PADI to sign in. Try again later.",
} as const;

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

function buildResult(
  raw: { idToken?: unknown; refreshToken?: unknown; expiresIn?: unknown },
  method: LoginMethod,
  fallbackClientId: string,
  previousRefreshToken: string | undefined,
  now: number,
): SignInResult {
  const idToken = typeof raw.idToken === "string" ? raw.idToken : "";
  const payload = idToken ? decodeJwt(idToken) : undefined;
  if (!payload) throw new PadiAuthError("unknown", "PADI answered the sign-in without a usable ID token.");
  const claims = claimsFromPayload(payload);
  if (!claims) throw new PadiAuthError("unknown", "The PADI sign-in token has no PADI affiliate id. This account cannot use the logbook.");
  const refreshToken = typeof raw.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : previousRefreshToken;
  if (!refreshToken) throw new PadiAuthError("unknown", "PADI answered the sign-in without a refresh token.");
  const expiresIn = typeof raw.expiresIn === "number" && raw.expiresIn > 0 ? raw.expiresIn : DEFAULT_LIFETIME_S;
  const idTokenExpiresAt = jwtExpiresAt(payload) ?? now + expiresIn * 1000;
  return {
    tokens: { refreshToken, loginMethod: method, clientId: jwtAudience(payload) ?? fallbackClientId, idToken, idTokenExpiresAt },
    claims,
  };
}

// ---------------------------------------------------------------------------------------------
// Cognito
// ---------------------------------------------------------------------------------------------

interface CognitoAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function cognitoCall(params: Record<string, unknown>, opts: AuthOptions): Promise<CognitoAnswer> {
  let res: Response;
  try {
    res = await padiFetch(
      opts.endpoints.cognitoUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        },
        body: JSON.stringify(params),
      },
      {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
        // A sign-in is never sent twice once it reached PADI (each failed try counts).
        idempotent: false,
        what: "PADI sign-in",
      },
    );
  } catch (error) {
    throw new PadiAuthError("network", MSG.network, { cause: error });
  }
  const text = await readText(res);
  const parsed = parseJson(text);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { status: res.status, body };
}

/** The Cognito error name, without the "namespace#" prefix some answers carry. */
function cognitoErrorType(body: Record<string, unknown>): string {
  const raw = typeof body.__type === "string" ? body.__type : typeof body.code === "string" ? body.code : "";
  return raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw;
}

function cognitoMessage(body: Record<string, unknown>): string {
  const m = body.message ?? body.Message;
  return typeof m === "string" ? m : "";
}

function mapCognitoError(answer: CognitoAnswer, flow: "password" | "refresh"): PadiAuthError {
  const type = cognitoErrorType(answer.body);
  const message = cognitoMessage(answer.body);
  if (flow === "refresh") {
    if (type === "NotAuthorizedException" || (type === "InvalidParameterException" && /refresh/i.test(message))) {
      return new PadiAuthError("expired", MSG.expired);
    }
  } else {
    if (type === "NotAuthorizedException") {
      if (/attempts exceeded/i.test(message)) return new PadiAuthError("bad_credentials", MSG.locked, { refusal: "locked" });
      if (/disabled/i.test(message)) return new PadiAuthError("bad_credentials", MSG.disabled, { refusal: "disabled" });
      return new PadiAuthError("bad_credentials", MSG.badCredentials);
    }
    if (type === "UserNotFoundException") return new PadiAuthError("bad_credentials", MSG.badCredentials);
  }
  if (type === "UserNotConfirmedException") return new PadiAuthError("not_confirmed", MSG.notConfirmed);
  if (type === "PasswordResetRequiredException") return new PadiAuthError("password_reset", MSG.passwordReset);
  if (type === "TooManyRequestsException" || type === "LimitExceededException") {
    return new PadiAuthError("unknown", "PADI is busy with too many sign-ins. Wait a minute and try again.");
  }
  if (answer.status >= 500 || type === "InternalErrorException") return new PadiAuthError("network", MSG.network);
  const what = type || `HTTP ${answer.status}`;
  return new PadiAuthError("unknown", `The PADI sign-in failed (${what}).`);
}

function challengeError(name: string): PadiAuthError {
  if (name === "NEW_PASSWORD_REQUIRED") return new PadiAuthError("challenge", MSG.newPassword);
  if (/MFA|SOFTWARE_TOKEN|SMS|EMAIL_OTP/.test(name)) return new PadiAuthError("challenge", MSG.mfa);
  return new PadiAuthError("challenge", `PADI asks for an extra sign-in step (${name.replace(/[^A-Z0-9_]/gi, "")}). This server cannot do that step. Sign in at account.padi.com first.`);
}

function cognitoResult(answer: CognitoAnswer, flow: "password" | "refresh", clientId: string, previous: string | undefined, now: number): SignInResult {
  if (answer.status !== 200) throw mapCognitoError(answer, flow);
  if (typeof answer.body.ChallengeName === "string" && answer.body.ChallengeName) throw challengeError(answer.body.ChallengeName);
  const auth = answer.body.AuthenticationResult as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== "object") throw new PadiAuthError("unknown", "PADI answered the sign-in without tokens.");
  return buildResult({ idToken: auth.IdToken, refreshToken: auth.RefreshToken, expiresIn: auth.ExpiresIn }, "cognito", clientId, previous, now);
}

async function cognitoSignIn(email: string, password: string, opts: AuthOptions): Promise<SignInResult> {
  const clientId = opts.endpoints.clientId;
  const answer = await cognitoCall({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: { USERNAME: email, PASSWORD: password } }, opts);
  return cognitoResult(answer, "password", clientId, undefined, (opts.now ?? Date.now)());
}

async function cognitoRefresh(tokens: StoredPadiTokens, opts: AuthOptions): Promise<SignInResult> {
  const answer = await cognitoCall({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: tokens.clientId, AuthParameters: { REFRESH_TOKEN: tokens.refreshToken } }, opts);
  // Cognito does not hand out a new refresh token here: the stored one stays.
  return cognitoResult(answer, "refresh", tokens.clientId, tokens.refreshToken, (opts.now ?? Date.now)());
}

// ---------------------------------------------------------------------------------------------
// PADI auth API
// ---------------------------------------------------------------------------------------------

async function padiAuthCall(path: string, body: Record<string, unknown>, opts: AuthOptions): Promise<{ status: number; text: string; json: unknown }> {
  let res: Response;
  try {
    res = await padiFetch(
      `${opts.endpoints.authUrl}${path}`,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
      {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
        idempotent: false,
        what: "PADI sign-in",
      },
    );
  } catch (error) {
    throw new PadiAuthError("network", MSG.network, { cause: error });
  }
  const text = await readText(res);
  return { status: res.status, text, json: parseJson(text) };
}

/** The tokens of a PADI auth API answer: `{tokens:{...}}` or the tokens at the top level. */
function padiTokens(json: unknown): { idToken?: unknown; refreshToken?: unknown; expiresIn?: unknown } | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  for (const candidate of [o.tokens, (o.data as Record<string, unknown> | undefined)?.tokens, o.data, o]) {
    if (candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).idToken === "string") {
      return candidate as { idToken?: unknown; refreshToken?: unknown; expiresIn?: unknown };
    }
  }
  return undefined;
}

/** The error text of a PADI auth API answer: a plain string, or JSON with message/error. */
function padiErrorText(text: string, json: unknown): string {
  if (typeof json === "string") return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    const parts = [o.message, o.error, o.code, o.name, o.__type].filter((v): v is string => typeof v === "string");
    if (parts.length) return parts.join(" ");
  }
  return text;
}

function mapPadiError(status: number, text: string, json: unknown, flow: "password" | "refresh"): PadiAuthError {
  const message = padiErrorText(text, json);
  if (/not confirmed|UserNotConfirmed/i.test(message)) return new PadiAuthError("not_confirmed", MSG.notConfirmed);
  if (/PasswordResetRequired|reset (your|the) password|password reset required/i.test(message)) return new PadiAuthError("password_reset", MSG.passwordReset);
  if (flow === "refresh") {
    if (status >= 400 && status < 500 && status !== 429) return new PadiAuthError("expired", MSG.expired);
  } else {
    if (/attempts exceeded/i.test(message)) return new PadiAuthError("bad_credentials", MSG.locked, { refusal: "locked" });
    if (/Incorrect username or password|NotAuthorized|UserNotFound|user does not exist|invalid (username|credentials|password)/i.test(message)) {
      return new PadiAuthError("bad_credentials", MSG.badCredentials);
    }
    if (status === 401 || status === 403) return new PadiAuthError("bad_credentials", MSG.badCredentials);
  }
  if (status === 429) return new PadiAuthError("unknown", "PADI is busy with too many sign-ins. Wait a minute and try again.");
  if (status >= 500) return new PadiAuthError("network", MSG.network);
  return new PadiAuthError("unknown", `The PADI sign-in failed (HTTP ${status}).`);
}

async function padiSignIn(email: string, password: string, opts: AuthOptions): Promise<SignInResult> {
  const clientId = opts.endpoints.clientId;
  const answer = await padiAuthCall("/oauth/login", { username: email, password, clientId, extraData: "" }, opts);
  const tokens = answer.status >= 200 && answer.status < 300 ? padiTokens(answer.json) : undefined;
  if (!tokens) {
    if (answer.status >= 200 && answer.status < 300) {
      // Some errors come back as HTTP 200 with a message.
      const err = mapPadiError(400, answer.text, answer.json, "password");
      if (err.code !== "unknown") throw err;
      throw new PadiAuthError("unknown", "PADI answered the sign-in without tokens.");
    }
    throw mapPadiError(answer.status, answer.text, answer.json, "password");
  }
  return buildResult(tokens, "padi", clientId, undefined, (opts.now ?? Date.now)());
}

async function padiRefresh(stored: StoredPadiTokens, opts: AuthOptions): Promise<SignInResult> {
  const answer = await padiAuthCall(
    "/oauth/refresh",
    { refreshToken: stored.refreshToken, clientId: stored.clientId, ...(stored.idToken ? { idToken: stored.idToken } : {}) },
    opts,
  );
  const tokens = answer.status >= 200 && answer.status < 300 ? padiTokens(answer.json) : undefined;
  if (!tokens) {
    if (answer.status >= 200 && answer.status < 300) throw new PadiAuthError("expired", MSG.expired);
    throw mapPadiError(answer.status, answer.text, answer.json, "refresh");
  }
  // The PADI auth API may hand out a new refresh token; without one, the stored one stays.
  return buildResult(tokens, "padi", stored.clientId, stored.refreshToken, (opts.now ?? Date.now)());
}

// ---------------------------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------------------------

/** Sign in with e-mail and password. Throws PadiAuthError. */
export async function signIn(
  email: string,
  password: string,
  opts: { method: "auto" | LoginMethod } & AuthOptions,
): Promise<SignInResult> {
  const username = email.trim().toLowerCase();
  if (!username || !password) throw new PadiAuthError("bad_credentials", "Enter your PADI e-mail and password.");
  if (opts.method === "cognito") return cognitoSignIn(username, password, opts);
  if (opts.method === "padi") return padiSignIn(username, password, opts);
  try {
    return await cognitoSignIn(username, password, opts);
  } catch (error) {
    // Wrong credentials and other "the user must act" answers are final: never try again.
    if (!(error instanceof PadiAuthError) || FINAL_CODES.has(error.code)) throw error;
    try {
      return await padiSignIn(username, password, opts);
    } catch (second) {
      if (second instanceof PadiAuthError && (FINAL_CODES.has(second.code) || error.code === "unknown")) throw second;
      throw error;
    }
  }
}

/**
 * Get a fresh ID token with a refresh token, the same way it was issued. A Cognito refresh token
 * does not rotate: the result keeps the stored one. The PADI auth API may return a new one.
 * Throws PadiAuthError with code "expired" when the refresh token is invalid or expired.
 */
export async function refresh(tokens: StoredPadiTokens, opts: AuthOptions): Promise<SignInResult> {
  if (!tokens.refreshToken) throw new PadiAuthError("expired", MSG.expired);
  return tokens.loginMethod === "padi" ? padiRefresh(tokens, opts) : cognitoRefresh(tokens, opts);
}

/** True for an error that means "PADI could not be reached" (worth trying again later). */
export function isNetworkProblem(error: unknown): boolean {
  return (error instanceof PadiAuthError && error.code === "network") || error instanceof PadiHttpError;
}
