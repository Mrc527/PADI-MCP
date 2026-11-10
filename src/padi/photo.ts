/**
 * Images from PADI: the file type by its first bytes (dive photos and the profile photo), and the
 * diver's profile photo.
 *
 * The profile photo is the photo on the diver's certification cards (eCards). The PADI website
 * shows it as the picture in its top bar. Getting it takes two steps (docs/padi-api.md section 6.2):
 *
 * 1. GET <photoUrl>?status=approved with the bearer token (src/padi/api.ts; a redirect is not
 *    followed). PADI answers JSON { preSignedURL, status, office }. Only status "APPROVED" with a
 *    link is a photo; "NO_PHOTO", a photo that waits for approval, or any other JSON means no
 *    photo. An answer that is not JSON at all is a failed check (tried again later).
 * 2. The link is a pre-signed address on a storage host, not on PADI's API. It is fetched without
 *    any PADI header or token, and only when that is safe: https on the standard port, a public
 *    address (checked before connecting, and the connection is pinned to the checked address),
 *    at most two redirects (each checked again), 10 s, 2 MB, and only JPEG, PNG, GIF or WebP by
 *    the file's first bytes (never by the Content-Type header).
 *
 * The link is a secret (anyone who has it can read the photo until it expires): it is never
 * logged and never put in an error. Errors name the host only.
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { ProfilePhoto } from "../logbook/types.js";
import { isPrivateAddress } from "../util/net.js";

/** The image type from the first bytes, or "application/octet-stream" when it is not a known image. */
export function sniffImageType(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.length >= 12 && data.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1)$/.test(data.subarray(8, 12).toString("latin1"))) return "image/heic";
  return "application/octet-stream";
}

/** The types a profile photo may have (browsers show them all; nothing that can hold a script). */
export const PROFILE_PHOTO_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Limits of the photo download. */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_TIMEOUT_MS = 10_000;
export const PHOTO_MAX_REDIRECTS = 2;

/**
 * A photo link that could not be read. `final`: asking again will not help (the link is not
 * allowed, or the file is not a photo), so there is no photo. Otherwise the check failed and is
 * tried again later. The reason names the host at most, never the link.
 */
export class PhotoLinkError extends Error {
  constructor(
    readonly reason: string,
    readonly final: boolean,
  ) {
    super(reason);
    this.name = "PhotoLinkError";
  }
}

/** A status value from PADI, safe to write to the log. */
function statusName(value: string): string {
  return /^[A-Z_]{1,30}$/.test(value) ? value.toLowerCase() : "unknown";
}

/**
 * The photo link in PADI's answer to step 1, or why there is no photo. Anything that is not an
 * approved photo with a link is no photo (also an answer this code does not understand).
 */
export function photoLinkFrom(json: unknown): { link: string } | { none: string } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { none: "PADI's photo answer was not understood" };
  const o = json as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status.trim().toUpperCase() : "";
  if (status === "NO_PHOTO") return { none: "no certification photo at PADI" };
  if (status !== "APPROVED") return { none: status ? `the certification photo is not approved (${statusName(status)})` : "PADI's photo answer has no status" };
  const raw = o.preSignedURL ?? o.preSignedUrl ?? o.presignedUrl;
  const link = typeof raw === "string" ? raw.trim() : "";
  if (!link) return { none: "PADI's photo answer has no photo link" };
  return { link };
}

/** DNS lookup of a host name: every address (tests pass their own). */
export type HostLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: HostLookup = (host) => lookup(host, { all: true });

export interface PhotoDownloadOptions {
  /**
   * Download with this fetch (tests pass a mock). Default: node:http(s), with the connection
   * pinned to the address that passed the check.
   */
  fetch?: typeof fetch;
  lookup?: HostLookup;
  /** Allow http and private addresses: only for the operator's local mock PADI (tests). */
  allowLocal?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** What the download needs of an HTTP answer, from fetch or from node:http. */
interface Answer {
  status: number;
  location: string | undefined;
  /** From the Content-Length header, when given. */
  length: number | undefined;
  body: AsyncIterable<Uint8Array> | null;
  discard(): void;
}

/** The only headers sent to the photo host: no token, no PADI header, no cookie. */
const PHOTO_HEADERS: Readonly<Record<string, string>> = Object.freeze({ accept: "image/*", "user-agent": "padi-mcp" });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function lengthOf(value: string | null | undefined): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** `promise`, or a rejection once `signal` aborts (the download's deadline). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The address to connect to, after the safety checks. Throws a final PhotoLinkError when the link is not allowed. */
async function checkLink(url: URL, allowLocal: boolean, lookupFn: HostLookup, signal: AbortSignal): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) {
    throw new PhotoLinkError(`photo link to ${url.protocol.replace(/:$/, "")}://${host} not followed (only https)`, true);
  }
  if (url.username || url.password) throw new PhotoLinkError(`photo link to ${host} not followed (it holds a user name)`, true);
  // Storage links use the standard https port. Another port could reach a service that is not a
  // storage host (url.port is empty for the default port, also when the link names 443).
  if (!allowLocal && url.port !== "") throw new PhotoLinkError(`photo link to ${host}:${url.port} not followed (only the standard https port)`, true);
  const family = isIP(host);
  if (family) {
    if (!allowLocal && isPrivateAddress(host)) throw new PhotoLinkError(`photo link to a private address (${host}) not followed`, true);
    return { address: host, family };
  }
  const addresses = await untilAborted(lookupFn(host), signal).catch(() => []);
  if (!addresses.length) throw new PhotoLinkError(`photo host ${host} cannot be resolved`, false);
  if (!allowLocal && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new PhotoLinkError(`photo host ${host} has a private address; not followed`, true);
  }
  return addresses[0]!;
}

async function viaFetch(doFetch: typeof fetch, url: URL, signal: AbortSignal): Promise<Answer> {
  const res = await doFetch(url.href, { method: "GET", headers: { ...PHOTO_HEADERS }, redirect: "manual", credentials: "omit", signal });
  return {
    status: res.status,
    location: res.headers.get("location") ?? undefined,
    length: lengthOf(res.headers.get("content-length")),
    body: res.body,
    discard: () => void res.body?.cancel().catch(() => undefined),
  };
}

/** A GET over node:http(s) that connects only to `target` (no new DNS answer between check and use). */
function viaNode(url: URL, target: { address: string; family: number }, signal: AbortSignal): Promise<Answer> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const pinned = ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
    opts && opts.all ? cb(null, [target]) : cb(null, target.address, target.family)) as unknown as LookupFunction;
  return new Promise<Answer>((resolve, reject) => {
    const req = request(url, { method: "GET", headers: { ...PHOTO_HEADERS }, lookup: pinned, signal, agent: false }, (res: IncomingMessage) => {
      // Errors while reading reach the reader below; this only keeps an unread answer from crashing the process.
      res.on("error", () => undefined);
      const location = res.headers.location;
      resolve({
        status: res.statusCode ?? 0,
        location: typeof location === "string" ? location : undefined,
        length: lengthOf(res.headers["content-length"]),
        body: (async function* () {
          for await (const chunk of res) yield chunk as Buffer;
          if (!res.complete) throw new Error("the connection closed before the end of the photo");
        })(),
        discard: () => res.destroy(),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Read at most `max` bytes; stops reading (and closes the connection) beyond that. */
async function readLimited(body: AsyncIterable<Uint8Array> | null, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!body) return Buffer.alloc(0);
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > max) throw new PhotoLinkError(`photo is larger than ${Math.round(max / 1024 / 1024)} MB`, true);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return signal.aborted || name === "TimeoutError" || name === "AbortError";
}

/**
 * Download the photo behind a pre-signed link, with the rules at the top of this file. Returns
 * the photo, or throws a PhotoLinkError (final: no photo; otherwise: try again later).
 */
export async function downloadProfilePhoto(link: string, opts: PhotoDownloadOptions = {}): Promise<ProfilePhoto> {
  const timeoutMs = opts.timeoutMs ?? PHOTO_TIMEOUT_MS;
  const max = opts.maxBytes ?? PHOTO_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? PHOTO_MAX_REDIRECTS;
  const lookupFn = opts.lookup ?? systemLookup;
  const allowLocal = opts.allowLocal === true;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new PhotoLinkError("PADI's photo link is not a web address", true);
  }
  // One deadline for everything: redirects and reading the photo.
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; ; redirects++) {
    const target = await checkLink(url, allowLocal, lookupFn, signal);
    const host = url.host;
    let answer: Answer;
    try {
      answer = opts.fetch ? await viaFetch(opts.fetch, url, signal) : await viaNode(url, target, signal);
    } catch (error) {
      if (isTimeout(error, signal)) throw new PhotoLinkError(`photo host ${host} did not answer within ${Math.round(timeoutMs / 1000)} s`, false);
      throw new PhotoLinkError(`could not reach the photo host ${host}`, false);
    }
    if (REDIRECTS.has(answer.status)) {
      answer.discard();
      if (!answer.location) throw new PhotoLinkError(`photo host ${host} answered HTTP ${answer.status} without a Location`, false);
      if (redirects >= maxRedirects) throw new PhotoLinkError(`too many redirects for the photo link (${host})`, false);
      try {
        url = new URL(answer.location, url);
      } catch {
        throw new PhotoLinkError(`photo host ${host} redirected to an address that is not valid`, true);
      }
      continue;
    }
    if (answer.status === 404 || answer.status === 410) {
      answer.discard();
      throw new PhotoLinkError(`photo host ${host} answered HTTP ${answer.status}`, true);
    }
    if (answer.status < 200 || answer.status >= 300) {
      answer.discard();
      throw new PhotoLinkError(`photo host ${host} answered HTTP ${answer.status}`, false);
    }
    if (answer.length !== undefined && answer.length > max) {
      answer.discard();
      throw new PhotoLinkError(`photo is larger than ${Math.round(max / 1024 / 1024)} MB`, true);
    }
    let data: Buffer;
    try {
      data = await readLimited(answer.body, max);
    } catch (error) {
      if (error instanceof PhotoLinkError) throw error;
      if (isTimeout(error, signal)) throw new PhotoLinkError(`photo host ${host} did not send the photo within ${Math.round(timeoutMs / 1000)} s`, false);
      throw new PhotoLinkError(`the photo from ${host} could not be read`, false);
    }
    const type = sniffImageType(data);
    if (!PROFILE_PHOTO_TYPES.has(type)) throw new PhotoLinkError("photo is not a JPEG, PNG, GIF or WebP image", true);
    return { data, type };
  }
}
