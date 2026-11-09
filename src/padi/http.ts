/**
 * The fetch wrapper for every PADI request: a timeout, a few tries with backoff, and errors that
 * are safe to show (never a token, never a password).
 *
 * Retry rules:
 * - at most 3 tries in all;
 * - HTTP 429 (throttled: PADI did not handle the request) is tried again for any request;
 * - HTTP 5xx, a timeout or a broken connection is tried again only for requests that are safe to
 *   send twice (reads). A write may have reached PADI already, so it is not sent again;
 * - a connection that could not be opened at all (DNS failure, connection refused) is tried again
 *   for any request: nothing was sent.
 */

import { UserFacingError } from "../util/errors.js";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_TRIES = 3;
const MAX_RETRY_AFTER_MS = 10_000;

export type PadiHttpErrorKind = "http" | "timeout" | "network";

/** A PADI request that failed. The message is safe to show. */
export class PadiHttpError extends UserFacingError {
  readonly kind: PadiHttpErrorKind;
  /** HTTP status, when PADI answered. */
  readonly status?: number;
  /** False when the request certainly never left this server. */
  readonly sent: boolean;

  constructor(kind: PadiHttpErrorKind, message: string, opts: { status?: number; sent?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PadiHttpError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    this.sent = opts.sent ?? true;
  }
}

export interface PadiRequestOptions {
  fetch?: typeof fetch;
  /** Per try. Default 20 s. */
  timeoutMs?: number;
  /** Tries in all, default 3. */
  tries?: number;
  /** Safe to send again after it may have reached PADI (reads). Default: true for GET. */
  idempotent?: boolean;
  /** First backoff step in ms (default 500); it triples on each try. Tests use 0. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** What the request is for, for error messages, for example "the PADI logbook". */
  what?: string;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Error codes of a connection that was never opened: the request did not leave this server. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 4) return [];
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown };
  const out: string[] = [];
  if (typeof e.code === "string") out.push(e.code);
  if (e.cause) out.push(...errorCodes(e.cause, depth + 1));
  if (Array.isArray(e.errors)) for (const inner of e.errors) out.push(...errorCodes(inner, depth + 1));
  return out;
}

/** True when a fetch error happened before anything was sent (the connection never opened). */
export function failedBeforeSending(error: unknown): boolean {
  const codes = errorCodes(error);
  return codes.length > 0 && codes.every((c) => NOT_SENT_CODES.has(c));
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" || errorCodes(error).includes("UND_ERR_HEADERS_TIMEOUT");
}

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
  return undefined;
}

function backoff(base: number, attempt: number): number {
  if (base <= 0) return 0;
  const step = base * 3 ** (attempt - 1);
  return Math.round(step + Math.random() * (base / 2));
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to do: the body is thrown away anyway.
  }
}

/**
 * Send a request with the retry rules above. Returns the last response, whatever its status
 * (callers map 401, 404 and the rest). Throws PadiHttpError for a timeout or a network error.
 */
export async function padiFetch(url: string, init: RequestInit, opts: PadiRequestOptions = {}): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tries = Math.max(1, opts.tries ?? DEFAULT_TRIES);
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = opts.idempotent ?? (method === "GET" || method === "HEAD");
  const base = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? realSleep;
  const what = opts.what ?? "PADI";

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= tries;
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const notSent = failedBeforeSending(error);
      if (!last && (notSent || idempotent)) {
        await sleep(backoff(base, attempt));
        continue;
      }
      if (isTimeout(error)) {
        throw new PadiHttpError("timeout", `${what} did not answer within ${Math.round(timeoutMs / 1000)} s. Try again later.`, { sent: true, cause: error });
      }
      throw new PadiHttpError("network", `Could not reach ${what}. Check the network and try again later.`, { sent: !notSent, cause: error });
    }
    const retriable = res.status === 429 || (idempotent && res.status >= 500 && res.status !== 501);
    if (!retriable || last) return res;
    const wait = retryAfterMs(res) ?? backoff(base, attempt);
    await discard(res);
    await sleep(wait);
  }
}

/** Read a response body as text, never throwing (an empty string when it cannot be read). */
export async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse JSON text, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A short, single-line piece of a response body for an error message. */
export function bodySnippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

/** An error for an unexpected HTTP status. */
export function statusError(what: string, res: Response, body = ""): PadiHttpError {
  const detail = bodySnippet(body);
  let hint = "";
  if (res.status === 401 || res.status === 403) hint = " PADI did not accept the sign-in.";
  else if (res.status === 429) hint = " PADI is busy (too many requests). Wait a minute and try again.";
  else if (res.status >= 500) hint = " PADI has a problem right now. Try again later.";
  return new PadiHttpError("http", `${what} answered HTTP ${res.status}.${hint}${detail ? ` (${detail})` : ""}`, { status: res.status });
}
