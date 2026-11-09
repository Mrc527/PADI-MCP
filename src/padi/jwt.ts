/**
 * Read the payload of a JWT (the PADI ID token). There is no signature check: the token comes
 * straight from PADI over HTTPS, and PADI checks it on every request. We only read the expiry and
 * the claims that say who the user is.
 */

import type { PadiClaims } from "./auth.js";

export type JwtPayload = Record<string, unknown>;

/** The payload of a JWT, or undefined when the text is not a JWT with a JSON payload. */
export function decodeJwt(token: string): JwtPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return payload as JwtPayload;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** When the token expires (epoch milliseconds), from the "exp" claim. */
export function jwtExpiresAt(payload: JwtPayload): number | undefined {
  const exp = payload.exp;
  const n = typeof exp === "number" ? exp : typeof exp === "string" ? Number(exp) : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/** The app client the token was issued for ("aud", or "client_id" in an access token). */
export function jwtAudience(payload: JwtPayload): string | undefined {
  const aud = payload.aud;
  if (Array.isArray(aud)) return str(aud[0]);
  return str(aud) ?? str(payload.client_id);
}

/** A PADI Pro has custom:affiliate_type_id "2" or "3". */
export function isProClaim(payload: JwtPayload): boolean {
  const type = str(payload["custom:affiliate_type_id"]);
  return type === "2" || type === "3";
}

/**
 * The claims the server uses, or undefined when the token has no PADI affiliate id (then it is
 * not a PADI ID token and no logbook query can be scoped).
 */
export function claimsFromPayload(payload: JwtPayload): PadiClaims | undefined {
  const affiliateId = str(payload["custom:affiliate_id"]);
  if (!affiliateId || !/^\d{1,15}$/.test(affiliateId)) return undefined;
  const given = str(payload.given_name);
  const family = str(payload.family_name);
  const name = [given, family].filter(Boolean).join(" ") || undefined;
  const email = str(payload.email)?.toLowerCase();
  const sub = str(payload.sub);
  return {
    affiliateId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    isPro: isProClaim(payload),
    ...(sub ? { sub } : {}),
  };
}
