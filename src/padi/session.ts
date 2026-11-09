/**
 * PadiSession: the token manager of one PADI account.
 *
 * It signs in (e-mail and password) or starts from stored tokens, hands out a valid ID token,
 * refreshes it when less than 120 s remain (one refresh at a time, shared by concurrent callers),
 * and tells the TokenSink when a new refresh token must be saved or when the stored one stopped
 * working (the user must sign in again).
 *
 * Rules:
 * - a refresh goes the way the token was issued (Cognito or the PADI auth API);
 * - a Cognito refresh keeps the stored refresh token; a PADI auth API refresh may hand out a new
 *   one, which is saved through the sink;
 * - when the refresh token stops working and a password is known (single-user mode), the session
 *   signs in again; without a password it calls sink.invalid() and fails with "expired";
 * - after PADI refused the e-mail or password, the session never tries again (that could lock the
 *   account): every later call fails with the same error, without a request.
 *
 * The token cache file (PADI_TOKEN_CACHE) is handled by the caller through the sink.
 */

import type { PadiEndpoints } from "./endpoints.js";
import { PadiAuthError, refresh, signIn, type AuthOptions, type LoginMethod, type PadiAuthErrorCode, type PadiClaims, type SignInResult, type StoredPadiTokens } from "./auth.js";
import { claimsFromPayload, decodeJwt, jwtExpiresAt } from "./jwt.js";

export { PadiAuthError, type LoginMethod, type PadiAuthErrorCode, type PadiClaims, type SignInResult, type StoredPadiTokens } from "./auth.js";

/** Where a session reports token changes (the web store, a cache file, or nothing). */
export interface TokenSink {
  /** A sign-in or refresh produced tokens worth keeping (a new refresh token, or a first sign-in). */
  save(tokens: StoredPadiTokens): void;
  /** The stored refresh token no longer works: the user must sign in again. */
  invalid(reason: string): void;
}

export interface PadiSessionOptions {
  email?: string;
  password?: string;
  tokens?: StoredPadiTokens;
  method: "auto" | LoginMethod;
  endpoints: PadiEndpoints;
  sink?: TokenSink;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Backoff of the HTTP layer (tests use 0). */
  backoffMs?: number;
  /** The clock (epoch ms), for tests. */
  now?: () => number;
}

/** Refresh when less than this is left of the ID token. */
export const REFRESH_MARGIN_MS = 120_000;
/** A token just received is used even when it is short-lived (clock skew), for this long. */
const JUST_RENEWED_MS = 30_000;

/** Refresh answers that mean "this refresh token no longer works". */
const DEAD_REFRESH_CODES: ReadonlySet<PadiAuthErrorCode> = new Set(["expired", "bad_credentials", "not_confirmed", "password_reset", "challenge"]);
/** Sign-in answers after which the session never tries again by itself. */
const FINAL_SIGN_IN_CODES: ReadonlySet<PadiAuthErrorCode> = new Set(["bad_credentials", "challenge", "not_confirmed", "password_reset"]);

interface CurrentToken {
  idToken: string;
  expiresAt: number;
  renewedAt: number;
  claims: PadiClaims;
}

export class PadiSession {
  private tokens: StoredPadiTokens | undefined;
  private current: CurrentToken | undefined;
  private inflight: Promise<string> | undefined;
  /** Set after an answer that needs the user (wrong password, dead refresh token). */
  private fatal: PadiAuthError | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: PadiSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.tokens = opts.tokens ? { ...opts.tokens } : undefined;
    // Stored tokens may still hold a valid ID token (for example right after "Save and test").
    const id = opts.tokens?.idToken;
    const payload = id ? decodeJwt(id) : undefined;
    const claims = payload ? claimsFromPayload(payload) : undefined;
    const expiresAt = opts.tokens?.idTokenExpiresAt ?? (payload ? jwtExpiresAt(payload) : undefined);
    if (id && claims && expiresAt) this.current = { idToken: id, expiresAt, renewedAt: 0, claims };
  }

  /** A valid ID token (signs in or refreshes first when needed). */
  async idToken(): Promise<string> {
    if (this.isFresh()) return this.current!.idToken;
    return this.renew();
  }

  /**
   * Refresh now (after an HTTP 401 or a GraphQL invalid-jwt), and return the new ID token. With
   * `staleToken`, the token that was refused: when another caller already replaced it, the
   * current token is returned without a new refresh.
   */
  async refreshNow(staleToken?: string): Promise<string> {
    if (this.inflight) return this.inflight;
    if (staleToken && this.current && this.current.idToken !== staleToken && this.isFresh()) return this.current.idToken;
    return this.renew();
  }

  /** The claims of the current ID token (signs in first when needed). */
  async claims(): Promise<PadiClaims> {
    if (!this.isFresh()) await this.renew();
    return this.current!.claims;
  }

  /** The method that issued the current tokens, once known. */
  get loginMethod(): LoginMethod | undefined {
    return this.tokens?.loginMethod ?? (this.opts.method === "auto" ? undefined : this.opts.method);
  }

  /** When the current ID token expires (epoch milliseconds), once there is one. */
  get tokenExpiresAt(): number | undefined {
    return this.current?.expiresAt ?? this.tokens?.idTokenExpiresAt;
  }

  /** The current tokens (what a sink would store), once there are any. */
  get storedTokens(): StoredPadiTokens | undefined {
    return this.tokens ? { ...this.tokens } : undefined;
  }

  private isFresh(): boolean {
    const c = this.current;
    if (!c) return false;
    const now = this.now();
    if (now < c.expiresAt - REFRESH_MARGIN_MS) return true;
    return now - c.renewedAt < JUST_RENEWED_MS && now < c.expiresAt;
  }

  /** One sign-in or refresh at a time; concurrent callers share it. */
  private renew(): Promise<string> {
    if (this.inflight) return this.inflight;
    const run = this.doRenew().finally(() => {
      if (this.inflight === run) this.inflight = undefined;
    });
    this.inflight = run;
    return run;
  }

  private authOptions(): AuthOptions {
    return {
      endpoints: this.opts.endpoints,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.backoffMs !== undefined ? { backoffMs: this.opts.backoffMs } : {}),
      now: this.now,
    };
  }

  private apply(result: SignInResult): string {
    this.tokens = { ...result.tokens };
    this.current = { idToken: result.tokens.idToken, expiresAt: result.tokens.idTokenExpiresAt, renewedAt: this.now(), claims: result.claims };
    return result.tokens.idToken;
  }

  private save(): void {
    if (!this.tokens) return;
    try {
      this.opts.sink?.save({ ...this.tokens });
    } catch {
      // A sink that cannot save must not break the request; the token still works in memory.
    }
  }

  private markInvalid(reason: string): void {
    try {
      this.opts.sink?.invalid(reason);
    } catch {
      // Same as above.
    }
  }

  private async doRenew(): Promise<string> {
    if (this.fatal) throw this.fatal;
    const canSignIn = !!(this.opts.email && this.opts.password);
    const hadStoredToken = !!this.tokens?.refreshToken;

    if (this.tokens?.refreshToken) {
      const before = this.tokens.refreshToken;
      try {
        const result = await refresh(this.tokens, this.authOptions());
        const token = this.apply(result);
        // A rotated refresh token must be kept, or the next start would use a dead one.
        if (result.tokens.refreshToken !== before) this.save();
        return token;
      } catch (error) {
        if (!(error instanceof PadiAuthError) || !DEAD_REFRESH_CODES.has(error.code)) throw error;
        // The refresh token no longer works.
        this.current = undefined;
        if (!canSignIn) {
          this.fatal = new PadiAuthError("expired", "Your PADI sign-in expired. Sign in to PADI again.", { cause: error });
          this.markInvalid("the refresh token was refused");
          throw this.fatal;
        }
      }
    }

    if (canSignIn) {
      try {
        const result = await signIn(this.opts.email!, this.opts.password!, { method: this.opts.method, ...this.authOptions() });
        const token = this.apply(result);
        this.save();
        return token;
      } catch (error) {
        if (error instanceof PadiAuthError && FINAL_SIGN_IN_CODES.has(error.code)) {
          this.fatal = error;
          if (hadStoredToken) this.markInvalid("signing in again failed");
        }
        throw error;
      }
    }

    throw new PadiAuthError("expired", "There is no PADI sign-in. Sign in to PADI with your e-mail and password.");
  }
}
