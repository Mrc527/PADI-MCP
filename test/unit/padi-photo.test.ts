/**
 * The PADI profile photo (the certification photo): PADI's answer, the safe download of the
 * pre-signed link, and the file type by the first bytes. fetch and DNS are mocked; the only real
 * connections go to a local test server. Nothing is sent to PADI.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PadiApi } from "../../src/padi/api.js";
import { customEndpoints, DEFAULT_ENDPOINTS, endpointsFromEnv } from "../../src/padi/endpoints.js";
import { PadiHttpError } from "../../src/padi/http.js";
import { downloadProfilePhoto, PHOTO_MAX_BYTES, PhotoLinkError, photoLinkFrom, sniffImageType, type HostLookup } from "../../src/padi/photo.js";
import { PadiSession } from "../../src/padi/session.js";
import { ConfigError } from "../../src/util/errors.js";
import { AFFILIATE_ID, cognitoOk, ENDPOINTS, idToken, json, mockFetch, refused, type Responder } from "./padi-fixtures.js";

const T0 = 1_800_000_000_000;

// Invented images: just the first bytes that make each type.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF invented photo")]);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("GIF89a invented");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 invented")]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic invented")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const PHOTO_API = `${ENDPOINTS.photoUrl}?status=approved`;
/** A pre-signed link (invented). The signature is a secret: it must never show up in an error. */
const SIGNATURE = "c2VjcmV0LXNpZ25hdHVyZS12YWx1ZQ";
const LINK = `https://storage.test/certification/photo-1.jpg?X-Amz-Expires=900&X-Amz-Signature=${SIGNATURE}`;

/** DNS of the tests: public addresses for the storage hosts, private ones for the traps. */
const HOSTS: Record<string, string[]> = {
  "storage.test": ["93.184.215.14"],
  "cdn.test": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "inside.test": ["10.1.2.3"],
  "loopback.test": ["127.0.0.1"],
  "metadata.test": ["169.254.169.254"],
  "mixed.test": ["93.184.215.15", "192.168.1.20"],
  "ula.test": ["fd12:3456:789a::1"],
};
const lookups: string[] = [];
const fakeLookup: HostLookup = async (host) => {
  lookups.push(host);
  return (HOSTS[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

const image = (data: Buffer, headers: Record<string, string> = {}) => new Response(new Uint8Array(data), { status: 200, headers: { "content-type": "image/jpeg", ...headers } });
const approved = (link = LINK) => json({ preSignedURL: link, status: "APPROVED", office: "Invented Office" });

function api(responder: Responder) {
  const m = mockFetch(responder);
  const session = new PadiSession({
    tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c", idToken: idToken({ nowMs: T0 }), idTokenExpiresAt: T0 + 3_600_000 },
    method: "auto",
    endpoints: ENDPOINTS,
    fetch: m.fetch,
    backoffMs: 0,
    now: () => T0 + 1000,
  });
  const notes: string[] = [];
  const a = new PadiApi({ session, endpoints: ENDPOINTS, apiMode: "proxy", fetch: m.fetch, backoffMs: 0, lookup: fakeLookup });
  return { api: a, requests: m.requests, notes, photo: () => a.getProfilePhoto({ note: (reason) => notes.push(reason) }) };
}

/** Answers step 1 with `first`, a token refresh with a new token, and the storage hosts with `storage`. */
function photoApi(first: () => Response, storage: (url: string) => Response | Promise<Response> = () => image(JPEG)) {
  return api((req) => {
    if (req.url === ENDPOINTS.cognitoUrl) return cognitoOk(idToken({ nowMs: T0, extra: { r: 1 } }));
    return req.url === PHOTO_API ? first() : storage(req.url);
  });
}

describe("PADI's photo answer", () => {
  it("gives a link only for an approved photo with a link", () => {
    expect(photoLinkFrom({ preSignedURL: LINK, status: "APPROVED", office: "x" })).toEqual({ link: LINK });
    expect(photoLinkFrom({ preSignedURL: ` ${LINK} `, status: "approved" })).toEqual({ link: LINK });
    expect(photoLinkFrom({ preSignedURL: LINK, status: "NO_PHOTO" })).toEqual({ none: "no certification photo at PADI" });
    expect(photoLinkFrom({ preSignedURL: LINK, status: "PENDING" })).toEqual({ none: "the certification photo is not approved (pending)" });
    expect(photoLinkFrom({ preSignedURL: LINK, status: "REJECTED" })).toEqual({ none: "the certification photo is not approved (rejected)" });
    // A status that is not a plain word is not written to the log as it is.
    expect(photoLinkFrom({ preSignedURL: LINK, status: "<b>odd</b>\nlog line" })).toEqual({ none: "the certification photo is not approved (unknown)" });
  });

  it("treats missing fields and unknown shapes as no photo", () => {
    for (const answer of [undefined, null, "text", 42, [], [{ status: "APPROVED", preSignedURL: LINK }], {}, { status: 1 }, { preSignedURL: LINK }]) {
      expect("none" in photoLinkFrom(answer), JSON.stringify(answer) ?? "undefined").toBe(true);
    }
    for (const link of [undefined, null, "", "  ", 42, {}, [LINK]]) {
      expect(photoLinkFrom({ status: "APPROVED", preSignedURL: link })).toEqual({ none: "PADI's photo answer has no photo link" });
    }
  });
});

describe("PadiApi.getProfilePhoto", () => {
  it("reads the approved photo: the token goes to PADI only, never to the storage host", async () => {
    const { requests, notes, photo } = photoApi(() => approved(), () => image(JPEG, { "content-type": "application/octet-stream" }));
    // The type comes from the bytes, not from the header.
    expect(await photo()).toEqual({ data: JPEG, type: "image/jpeg" });
    expect(notes).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual([PHOTO_API, LINK]);
    const [first, second] = requests;
    expect(first!.method).toBe("GET");
    expect(first!.headers.authorization).toMatch(/^Bearer eyJ/);
    expect(first!.headers["affiliate-id"]).toBe(AFFILIATE_ID);
    expect(second!.method).toBe("GET");
    expect(Object.keys(second!.headers).sort()).toEqual(["accept", "user-agent"]);
    expect(second!.headers.accept).toBe("image/*");
  });

  it("answers no photo for NO_PHOTO, a photo waiting for approval, and answers it does not understand", async () => {
    const answers: Array<[Response, string]> = [
      [json({ preSignedURL: null, status: "NO_PHOTO", office: null }), "no certification photo at PADI"],
      [json({ preSignedURL: LINK, status: "PENDING" }), "the certification photo is not approved (pending)"],
      [json({ status: "APPROVED" }), "PADI's photo answer has no photo link"],
      [json({ status: "APPROVED", preSignedURL: 42 }), "PADI's photo answer has no photo link"],
      [json({ unexpected: true }), "PADI's photo answer has no status"],
      [json([]), "PADI's photo answer was not understood"],
      [json(null), "PADI's photo answer was not understood"],
    ];
    for (const [answer, why] of answers) {
      const { requests, notes, photo } = photoApi(() => answer);
      expect(await photo()).toBeUndefined();
      expect(notes).toEqual([why]);
      // The storage host is never asked.
      expect(requests.map((r) => r.url)).toEqual([PHOTO_API]);
    }
  });

  it("signs in again once on HTTP 401", async () => {
    let calls = 0;
    const { requests, photo } = api((req) => {
      if (req.url === ENDPOINTS.cognitoUrl) return cognitoOk(idToken({ nowMs: T0, extra: { r: 1 } }));
      if (req.url === PHOTO_API) return ++calls === 1 ? new Response("", { status: 401 }) : approved();
      return image(PNG);
    });
    expect(await photo()).toEqual({ data: PNG, type: "image/png" });
    expect(requests.map((r) => r.url)).toEqual([PHOTO_API, ENDPOINTS.cognitoUrl, PHOTO_API, LINK]);
    expect(requests[2]!.headers.authorization).not.toBe(requests[0]!.headers.authorization);
  });

  it("fails (to try again later) when PADI answers an HTTP error or cannot be reached", async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      const { photo } = photoApi(() => new Response("{}", { status }));
      const error = await photo().catch((e: unknown) => e);
      expect(error, `HTTP ${status}`).toBeInstanceOf(PadiHttpError);
      expect((error as PadiHttpError).status).toBe(status);
    }
    const { photo } = api(() => {
      throw refused();
    });
    await expect(photo()).rejects.toBeInstanceOf(PadiHttpError);
  });

  it("fails (to try again later) when PADI's answer is not JSON at all, so a stored photo stays", async () => {
    // A maintenance or firewall page, or an empty answer, says nothing about the photo.
    for (const answer of [
      () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("", { status: 200 }),
      () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]) {
      const { requests, notes, photo } = photoApi(answer);
      const error = await photo().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PadiHttpError);
      expect(error).toMatchObject({ kind: "http", message: "The PADI photo service did not answer JSON." });
      expect((error as PadiHttpError).status).toBeUndefined();
      expect(notes).toEqual([]);
      expect(requests.map((r) => r.url)).toEqual([PHOTO_API]);
    }
  });

  it("refuses links to private, loopback, link-local and unique-local addresses, without connecting", async () => {
    const links = [
      "https://10.0.0.5/p.jpg",
      "https://127.0.0.1/p.jpg",
      "https://[::1]/p.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://[::ffff:169.254.169.254]/p.jpg",
      "https://[fd00::1]/p.jpg",
      "https://0.0.0.0/p.jpg",
      "https://224.0.0.1/p.jpg",
      "https://inside.test/p.jpg",
      "https://loopback.test/p.jpg",
      "https://metadata.test/p.jpg",
      "https://ula.test/p.jpg",
      // One private address among public ones is enough to refuse.
      "https://mixed.test/p.jpg",
    ];
    for (const link of links) {
      const { requests, notes, photo } = photoApi(() => approved(link));
      expect(await photo(), link).toBeUndefined();
      expect(requests.map((r) => r.url), link).toEqual([PHOTO_API]);
      expect(notes[0], link).toMatch(/private address/);
    }
  });

  it("refuses http links, links with a user name, and ports other than the standard one", async () => {
    for (const link of [
      "http://storage.test/p.jpg",
      "ftp://storage.test/p.jpg",
      "file:///etc/passwd",
      "https://user:pw@storage.test/p.jpg",
      "not a link",
      "https://storage.test:8443/p.jpg",
      "https://storage.test:22/p.jpg",
      "https://93.184.215.14:6379/p.jpg",
    ]) {
      const { requests, notes, photo } = photoApi(() => approved(link));
      expect(await photo(), link).toBeUndefined();
      expect(requests.map((r) => r.url), link).toEqual([PHOTO_API]);
      expect(notes, link).toHaveLength(1);
    }
    const { notes, photo } = photoApi(() => approved("http://storage.test/p.jpg"));
    await photo();
    expect(notes).toEqual(["photo link to http://storage.test not followed (only https)"]);
    const port = photoApi(() => approved("https://storage.test:8443/p.jpg"));
    await port.photo();
    expect(port.notes).toEqual(["photo link to storage.test:8443 not followed (only the standard https port)"]);
    // Port 443 written out is the standard port.
    const standard = photoApi(() => approved("https://storage.test:443/p.jpg"));
    expect(await standard.photo()).toEqual({ data: JPEG, type: "image/jpeg" });
    expect(standard.requests.map((r) => r.url)).toEqual([PHOTO_API, "https://storage.test/p.jpg"]);
  });

  it("follows at most two redirects, checking each one again", async () => {
    // Two redirects to public https hosts: followed, without the token.
    const hops: Record<string, Response> = {};
    const chain = (url: string) => {
      if (url === LINK) return new Response(null, { status: 302, headers: { location: "https://cdn.test/a.jpg?sig=1" } });
      if (url === "https://cdn.test/a.jpg?sig=1") return new Response(null, { status: 307, headers: { location: "/b.gif" } });
      if (url === "https://cdn.test/b.gif") return image(GIF);
      return hops[url] ?? new Response("", { status: 500 });
    };
    const ok = photoApi(() => approved(), chain);
    expect(await ok.photo()).toEqual({ data: GIF, type: "image/gif" });
    expect(ok.requests.map((r) => r.url)).toEqual([PHOTO_API, LINK, "https://cdn.test/a.jpg?sig=1", "https://cdn.test/b.gif"]);
    for (const r of ok.requests.slice(1)) expect(r.headers.authorization).toBeUndefined();

    // A redirect to a private address, to http or to another port is not followed: no photo.
    for (const location of ["https://169.254.169.254/latest", "https://inside.test/x", "http://cdn.test/x.jpg", "https://cdn.test:8080/x.jpg"]) {
      const trap = photoApi(() => approved(), (url) => (url === LINK ? new Response(null, { status: 301, headers: { location } }) : image(JPEG)));
      expect(await trap.photo(), location).toBeUndefined();
      expect(trap.requests.map((r) => r.url), location).toEqual([PHOTO_API, LINK]);
    }

    // A third redirect, or a redirect without a Location, fails (tried again later).
    const loop = photoApi(() => approved(), (url) => new Response(null, { status: 302, headers: { location: `${url.split("?")[0]}?n=${Math.random()}` } }));
    const error = await loop.photo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoLinkError);
    expect((error as PhotoLinkError).final).toBe(false);
    expect((error as PhotoLinkError).reason).toBe("too many redirects for the photo link (storage.test)");
    expect(loop.requests).toHaveLength(4);
    const bare = photoApi(() => approved(), () => new Response(null, { status: 302 }));
    await expect(bare.photo()).rejects.toThrow("photo host storage.test answered HTTP 302 without a Location");
  });

  it("refuses photos over 2 MB, and stops reading them", async () => {
    // Announced by Content-Length: not read at all.
    let pulled = 0;
    const big = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(256 * 1024).fill(0xff));
          },
        }),
        { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(3 * 1024 * 1024) } },
      );
    const announced = photoApi(() => approved(), big);
    expect(await announced.photo()).toBeUndefined();
    expect(announced.notes).toEqual(["photo is larger than 2 MB"]);
    expect(pulled).toBeLessThanOrEqual(2);

    // Sent without a length, endlessly: reading stops right after 2 MB.
    pulled = 0;
    let cancelled = false;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(256 * 1024).fill(0xff));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "image/jpeg" } },
      );
    const streamed = photoApi(() => approved(), endless);
    expect(await streamed.photo()).toBeUndefined();
    expect(streamed.notes).toEqual(["photo is larger than 2 MB"]);
    expect(cancelled).toBe(true);
    expect(pulled * 256 * 1024).toBeLessThanOrEqual(PHOTO_MAX_BYTES + 3 * 256 * 1024);

    // Exactly 2 MB is fine.
    const limit = Buffer.alloc(PHOTO_MAX_BYTES, 0);
    JPEG.copy(limit);
    const fits = photoApi(() => approved(), () => image(limit));
    expect((await fits.photo())?.data.length).toBe(PHOTO_MAX_BYTES);
  });

  it("accepts only JPEG, PNG, GIF and WebP, by the first bytes", async () => {
    for (const [data, type] of [[JPEG, "image/jpeg"], [PNG, "image/png"], [GIF, "image/gif"], [WEBP, "image/webp"]] as const) {
      const { photo } = photoApi(() => approved(), () => image(data, { "content-type": "text/plain" }));
      expect(await photo()).toEqual({ data, type });
    }
    for (const data of [SVG, HEIC, Buffer.from("<html><body>Access denied</body></html>"), Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) {
      const { notes, photo } = photoApi(() => approved(), () => image(data, { "content-type": "image/jpeg" }));
      expect(await photo()).toBeUndefined();
      expect(notes).toEqual(["photo is not a JPEG, PNG, GIF or WebP image"]);
    }
  });

  it("finds no photo when the storage host says it is gone, and tries again later on other errors", async () => {
    for (const status of [404, 410]) {
      const { notes, photo } = photoApi(() => approved(), () => new Response("", { status }));
      expect(await photo()).toBeUndefined();
      expect(notes).toEqual([`photo host storage.test answered HTTP ${status}`]);
    }
    for (const status of [400, 403, 500, 503]) {
      const { photo } = photoApi(() => approved(), () => new Response("", { status }));
      const error = await photo().catch((e: unknown) => e);
      expect(error, `HTTP ${status}`).toBeInstanceOf(PhotoLinkError);
      expect((error as PhotoLinkError).final).toBe(false);
    }
    const unreachable = photoApi(() => approved(), () => {
      throw refused();
    });
    await expect(unreachable.photo()).rejects.toThrow("could not reach the photo host storage.test");
    // A host without an address may come back: tried again later.
    const unknown = photoApi(() => approved("https://unknown.test/p.jpg"));
    await expect(unknown.photo()).rejects.toThrow("photo host unknown.test cannot be resolved");
  });

  it("never puts the secret link in an error or a note", async () => {
    const reasons: string[] = [];
    const cases: Array<(url: string) => Response> = [
      () => new Response("", { status: 503 }),
      () => new Response(null, { status: 302 }),
      () => new Response("", { status: 404 }),
      () => image(SVG),
      () => {
        throw refused();
      },
    ];
    for (const storage of cases) {
      const { notes, photo } = photoApi(() => approved(), storage);
      const error = await photo().catch((e: unknown) => e);
      reasons.push(...notes, error instanceof Error ? `${error.message} ${(error as PhotoLinkError).reason ?? ""}` : "");
    }
    expect(reasons.join("\n")).not.toContain(SIGNATURE);
    expect(reasons.join("\n")).not.toContain("photo-1.jpg");
  });

  it("asks nothing when there is no photo address (the operator's mock without PADI_PHOTO_URL)", async () => {
    const m = mockFetch(() => approved());
    const session = new PadiSession({
      tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c", idToken: idToken({ nowMs: T0 }), idTokenExpiresAt: T0 + 3_600_000 },
      method: "auto",
      endpoints: ENDPOINTS,
      fetch: m.fetch,
      now: () => T0 + 1000,
    });
    const { photoUrl: _drop, ...noPhoto } = ENDPOINTS;
    void _drop;
    const notes: string[] = [];
    const a = new PadiApi({ session, endpoints: noPhoto, apiMode: "proxy", fetch: m.fetch, lookup: fakeLookup });
    expect(await a.getProfilePhoto({ note: (r) => notes.push(r) })).toBeUndefined();
    expect(m.requests).toHaveLength(0);
    expect(notes).toEqual(["no PADI photo address (the PADI addresses point to a test server)"]);
  });
});

describe("PADI's photo service over a real connection (local test server)", () => {
  it("does not follow a redirect, so the PADI headers never go anywhere else", async () => {
    const seen: Array<{ path: string; affiliate: unknown; authorization: unknown }> = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", affiliate: req.headers["affiliate-id"], authorization: req.headers.authorization });
      if (req.url?.startsWith("/p/photos/web/certification")) return void res.writeHead(302, { location: "/elsewhere" }).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ preSignedURL: LINK, status: "APPROVED" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const endpoints = { ...ENDPOINTS, photoUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/photos/web/certification` };
      const nothing = mockFetch(() => {
        throw new Error("no sign-in expected");
      });
      const session = new PadiSession({
        tokens: { refreshToken: "stored", loginMethod: "cognito", clientId: "c", idToken: idToken({ nowMs: T0 }), idTokenExpiresAt: T0 + 3_600_000 },
        method: "auto",
        endpoints,
        fetch: nothing.fetch,
        backoffMs: 0,
        now: () => T0 + 1000,
      });
      // No fetch given: Node's own fetch, as in production.
      const a = new PadiApi({ session, endpoints, apiMode: "proxy", backoffMs: 0, lookup: fakeLookup });
      const error = await a.getProfilePhoto().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PadiHttpError);
      expect((error as PadiHttpError).status).toBe(302);
      expect(seen.map((r) => r.path)).toEqual(["/p/photos/web/certification?status=approved"]);
      expect(seen[0]!.affiliate).toBe(AFFILIATE_ID);
      expect(seen[0]!.authorization).toMatch(/^Bearer eyJ/);
      expect(nothing.requests).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("the photo address", () => {
  it("is PADI's by default, and can be set by the operator", () => {
    expect(DEFAULT_ENDPOINTS.photoUrl).toBe("https://api.padi.com/p/photos/web/certification");
    expect(endpointsFromEnv({}).photoUrl).toBe(DEFAULT_ENDPOINTS.photoUrl);
    const custom = endpointsFromEnv({ PADI_PHOTO_URL: "http://127.0.0.1:9999/p/photos/web/certification/" });
    expect(custom.photoUrl).toBe("http://127.0.0.1:9999/p/photos/web/certification");
    expect(customEndpoints(custom)).toEqual(["PADI_PHOTO_URL"]);
    expect(() => endpointsFromEnv({ PADI_PHOTO_URL: "https://example.com/p?status=approved" })).toThrow(ConfigError);
  });

  it("is left out when other PADI addresses point to a mock but this one does not, so the real PADI is never asked", () => {
    const mock = endpointsFromEnv({ PADI_LOGBOOK_URL: "http://127.0.0.1:9999/api/Logbook", PADI_COGNITO_URL: "http://127.0.0.1:9999/cognito/" });
    expect(mock.photoUrl).toBeUndefined();
    expect(customEndpoints(mock)).toEqual(["PADI_COGNITO_URL", "PADI_LOGBOOK_URL"]);
    expect(endpointsFromEnv({ PADI_LOGBOOK_URL: "http://127.0.0.1:9999/api/Logbook", PADI_PHOTO_URL: "http://127.0.0.1:9999/photo" }).photoUrl).toBe("http://127.0.0.1:9999/photo");
    // A region or client id alone is no mock.
    expect(endpointsFromEnv({ PADI_COGNITO_REGION: "eu-central-1", PADI_CLIENT_ID: "x" }).photoUrl).toBe(DEFAULT_ENDPOINTS.photoUrl);
  });
});

describe("downloadProfilePhoto", () => {
  it("knows image types by their first bytes", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(HEIC)).toBe("image/heic");
    expect(sniffImageType(SVG)).toBe("application/octet-stream");
  });

  it("gives up after its deadline (tried again later)", async () => {
    const hanging = (async (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const error = await downloadProfilePhoto(LINK, { fetch: hanging, lookup: fakeLookup, timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoLinkError);
    expect(error).toMatchObject({ final: false });
    expect((error as PhotoLinkError).reason).toMatch(/^photo host storage\.test did not answer within \d+ s$/);
    // A DNS answer that never comes counts too.
    const slowDns: HostLookup = () => new Promise(() => undefined);
    await expect(downloadProfilePhoto(LINK, { fetch: hanging, lookup: slowDns, timeoutMs: 50 })).rejects.toThrow("photo host storage.test cannot be resolved");
  });

  describe("over a real connection (local test server)", () => {
    let server: Server;
    let port = 0;
    const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push({ path: req.url ?? "", headers: req.headers });
        if (req.url === "/photo.png") return void res.writeHead(200, { "content-type": "image/png" }).end(PNG);
        if (req.url === "/moved") return void res.writeHead(302, { location: "/photo.png" }).end();
        if (req.url === "/huge") {
          // No Content-Length (chunked), far more than 2 MB.
          res.writeHead(200, { "content-type": "image/jpeg" });
          const chunk = Buffer.alloc(64 * 1024, 0xff);
          let sent = 0;
          const write = () => {
            while (sent < 8 * 1024 * 1024 && !res.destroyed) {
              sent += chunk.length;
              if (!res.write(chunk)) return void res.once("drain", write);
            }
            res.end();
          };
          return write();
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    it("refuses a local server unless the operator's mock allows it", async () => {
      await expect(downloadProfilePhoto(`http://127.0.0.1:${port}/photo.png`)).rejects.toMatchObject({ final: true });
      await expect(downloadProfilePhoto(`https://127.0.0.1:${port}/photo.png`)).rejects.toMatchObject({ final: true });
      await expect(downloadProfilePhoto("https://127.0.0.1/photo.png")).rejects.toMatchObject({ final: true, reason: "photo link to a private address (127.0.0.1) not followed" });
      expect(seen).toHaveLength(0);
    });

    it("connects to the checked address only, follows a redirect, and sends no sign-in", async () => {
      // "photo.invalid" has no real address: the connection goes to the one the lookup gave.
      const local: HostLookup = async () => [{ address: "127.0.0.1", family: 4 }];
      const photo = await downloadProfilePhoto(`http://photo.invalid:${port}/moved`, { allowLocal: true, lookup: local });
      expect(photo).toEqual({ data: PNG, type: "image/png" });
      expect(seen.map((s) => s.path)).toEqual(["/moved", "/photo.png"]);
      for (const s of seen) {
        expect(s.headers.authorization).toBeUndefined();
        expect(s.headers["affiliate-id"]).toBeUndefined();
        expect(s.headers.cookie).toBeUndefined();
        expect(s.headers.host).toBe(`photo.invalid:${port}`);
      }
    });

    it("stops reading a photo over 2 MB", async () => {
      await expect(downloadProfilePhoto(`http://127.0.0.1:${port}/huge`, { allowLocal: true })).rejects.toMatchObject({ final: true, reason: "photo is larger than 2 MB" });
      const gone = await downloadProfilePhoto(`http://127.0.0.1:${port}/nothing`, { allowLocal: true }).catch((e: unknown) => e);
      expect(gone).toMatchObject({ final: true, reason: `photo host 127.0.0.1:${port} answered HTTP 404` });
    });
  });
});
