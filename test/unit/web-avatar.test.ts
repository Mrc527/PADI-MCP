/**
 * Profile photo: the certification photo of the user's PADI account, read through the user's own
 * services and shown on the pages. PADI is the in-process mock (test/helpers/mock-padi.ts), with
 * its fake storage host for the pre-signed photo links: nothing is ever sent to PADI.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/web/crypto.js";
import { createWebApp, type WebApp } from "../../src/web/server.js";
import { MOCK_ACCOUNT, startMockPadi, type MockPadi } from "../helpers/mock-padi.js";
import { Browser, setBase } from "../helpers/web-client.js";

// Invented images. The storage host says "image/jpeg" for both: the bytes decide.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("GIF89a invented second photo");

/** A second diver of the mock (invented), without a photo. */
const OTHER_DIVER = { email: "sky.example@example.com", password: "invented-password-2", affiliateId: "20000002", givenName: "Sky", familyName: "Example" };

describe("profile photo on the pages", () => {
  let mock: MockPadi;
  let web: WebApp;
  let server: Server;
  const logs: string[] = [];
  const PASSWORD = "correct horse battery";
  const user = new Browser();
  const userId = () => web.ctx.store.getUserByEmail("photo@example.com")!.id;
  const photoRequests = () => mock.count("/p/photos/web/certification");

  beforeAll(async () => {
    mock = await startMockPadi({
      accounts: [{ ...MOCK_ACCOUNT, certificationPhoto: { status: "APPROVED", data: PNG, type: "image/jpeg" } }, OTHER_DIVER],
    });
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setBase(base);
    web = await createWebApp({
      publicUrl: new URL(base),
      host: "127.0.0.1",
      port: 0,
      dataDir: ":memory:",
      operator: mock.env({ photo: true }),
      log: (m) => logs.push(m),
    });
    server.on("request", web.app);
    expect((await user.signup("photo@example.com", PASSWORD)).status).toBe(303);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await web.close();
    await mock.close();
  });

  const connect = async (b: Browser, diver: { email: string; password: string } = MOCK_ACCOUNT) => {
    const { csrf } = await b.page("/account");
    const res = await b.post("/account/padi", { _csrf: csrf, email: diver.email, password: diver.password, units: "metric", timeZone: "UTC" });
    expect(res.headers.get("location")).toBe("/account?m=connected");
  };

  it("shows initials until PADI is connected", async () => {
    const { html } = await user.page("/account");
    expect(html).not.toContain("/account/avatar");
    expect((await user.fetch("/account/avatar")).status).toBe(404);
    expect(photoRequests()).toBe(0);
  });

  it("shows the certification photo once PADI is connected", async () => {
    await connect(user);
    const { html } = await user.page("/account?m=connected");
    const src = html.match(/<img src="(\/account\/avatar\?v=\d+)"/)?.[1];
    expect(src).toBeTruthy();
    // In the top bar and in the profile header.
    expect(html.split(src!).length - 1).toBe(2);
    const res = await user.fetch(src!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // The browser asks again before each use (no copy is shown without a session).
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    // Asking again with the ETag is a short "not modified". (The cache-control header keeps
    // Node's fetch from adding "no-cache", which a browser does not send when it revalidates.)
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await user.fetch(src!, { headers: { "if-none-match": etag!, "cache-control": "max-age=0" } });
    expect(again.status).toBe(304);
    // PADI got the token, the storage host did not.
    expect(mock.violations).toEqual([]);
    expect(mock.count("/photo-storage/")).toBe(1);
    // Other pages show it in the top bar too, without asking PADI again.
    const before = mock.requests.length;
    expect((await user.page("/account/security")).html).toContain(src!);
    expect((await user.page("/account")).html).toContain(src!);
    expect(mock.requests.length).toBe(before);
  });

  it("is only served to its owner", async () => {
    expect((await new Browser().fetch("/account/avatar")).status).toBe(303);
    // After sign-out, a browser that kept the photo must ask again, and gets the sign-in page.
    const leaving = new Browser();
    expect((await leaving.login("photo@example.com", PASSWORD)).status).toBe(303);
    const src = (await leaving.page("/account")).html.match(/<img src="(\/account\/avatar\?v=\d+)"/)?.[1];
    const kept = await leaving.fetch(src!);
    expect(kept.status).toBe(200);
    const { csrf } = await leaving.page("/account");
    expect((await leaving.post("/logout", { _csrf: csrf })).status).toBe(303);
    const after = await leaving.fetch(src!, { headers: { "if-none-match": kept.headers.get("etag")!, "cache-control": "max-age=0" } });
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toMatch(/^\/login/);
    web.ctx.store.createUser("other@example.com", await hashPassword(PASSWORD), false);
    const other = new Browser();
    expect((await other.login("other@example.com", PASSWORD)).status).toBe(303);
    expect((await other.fetch("/account/avatar")).status).toBe(404);
    expect((await other.page("/account")).html).not.toContain("/account/avatar");
  });

  it("checks again a day later, and keeps the photo when PADI does not answer", async () => {
    const at = web.ctx.store.getUser(userId())!.avatarAt;
    web.ctx.store.markAvatarChecked(userId(), Date.now() - 2 * 86_400_000);
    mock.failNext("photo", 403);
    const { html } = await user.page("/account");
    expect(html).toContain(`/account/avatar?v=${at}`);
    expect(logs).toContain("Profile photo check failed (HTTP 403); trying again later");
    // Not asked again right away after a failure, but an hour later.
    const after = web.ctx.store.getUser(userId())!;
    expect(after.avatarCheckFailed).toBe(true);
    expect(web.ctx.avatars.due(after)).toBe(false);
    expect(web.ctx.avatars.due(after, Date.now() + 2 * 3_600_000)).toBe(true);
  });

  it("keeps the photo when the storage host fails for a while", async () => {
    const at = web.ctx.store.getUser(userId())!.avatarAt;
    web.ctx.store.markAvatarChecked(userId(), Date.now() - 2 * 86_400_000);
    mock.failNext("photo-storage", 503);
    const { html } = await user.page("/account");
    expect(html).toContain(`/account/avatar?v=${at}`);
    expect(web.ctx.store.getAvatar(userId())?.data.equals(PNG)).toBe(true);
    expect(logs.some((m) => /^Profile photo check failed \(photo host 127\.0\.0\.1:\d+ answered HTTP 503\); trying again later$/.test(m))).toBe(true);
    expect(web.ctx.store.getUser(userId())!.avatarCheckFailed).toBe(true);
  });

  it("signs in to PADI again when the token expired, as for tool calls", async () => {
    web.ctx.store.markAvatarChecked(userId(), Date.now() - 2 * 86_400_000);
    mock.account.certificationPhoto = { status: "APPROVED", data: GIF };
    mock.expireIdTokens();
    const signIns = mock.count("/cognito");
    const { html } = await user.page("/account");
    expect(mock.count("/cognito")).toBeGreaterThan(signIns);
    const src = html.match(/<img src="(\/account\/avatar\?v=\d+)"/)?.[1];
    expect(src).toBeTruthy();
    const res = await user.fetch(src!);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(Buffer.from(await res.arrayBuffer()).equals(GIF)).toBe(true);
    expect(web.ctx.store.getUser(userId())!.avatarCheckFailed).toBeUndefined();
  });

  it("finds no photo while it waits for approval, or when PADI has none", async () => {
    for (const status of ["PENDING", "NO_PHOTO"]) {
      web.ctx.store.markAvatarChecked(userId(), Date.now() - 2 * 86_400_000);
      mock.account.certificationPhoto = { status, data: PNG };
      expect((await user.page("/account")).html, status).not.toContain("/account/avatar");
      expect((await user.fetch("/account/avatar")).status, status).toBe(404);
    }
    expect(logs).toContain("No profile photo: the certification photo is not approved (pending)");
    expect(logs).toContain("No profile photo: no certification photo at PADI");
    // "No photo" is a result, not a failure: asked again a day later.
    const after = web.ctx.store.getUser(userId())!;
    expect(after.avatarCheckFailed).toBeUndefined();
    expect(web.ctx.avatars.due(after, Date.now() + 2 * 3_600_000)).toBe(false);
    expect(web.ctx.avatars.due(after, Date.now() + 86_400_000 + 60_000)).toBe(true);
  });

  it("drops the photo when the PADI connection is removed or another PADI account is connected", async () => {
    mock.account.certificationPhoto = { status: "APPROVED", data: PNG };
    await connect(user);
    expect((await user.page("/account")).html).toContain("/account/avatar?v=");
    // Another PADI account (without a photo): the old photo goes at once.
    await connect(user, OTHER_DIVER);
    expect(web.ctx.store.getAvatar(userId())).toBeUndefined();
    expect((await user.page("/account")).html).not.toContain("/account/avatar");

    await connect(user);
    expect((await user.page("/account")).html).toContain("/account/avatar?v=");
    const { csrf } = await user.page("/account");
    expect((await user.post("/account/padi/remove", { _csrf: csrf })).status).toBe(303);
    expect(web.ctx.store.getAvatar(userId())).toBeUndefined();
    expect(web.ctx.store.getUser(userId())!.avatarAt).toBeUndefined();
    expect((await user.page("/account")).html).not.toContain("/account/avatar");
    expect((await user.fetch("/account/avatar")).status).toBe(404);
  });

  it("throws a check away when the PADI connection changes while it runs", async () => {
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };
    // The form token comes from a page that does not check the photo (the account page would
    // wait for the held check).
    const csrf = async () => (await user.page("/account/security")).csrf;
    const connectNow = async (diver: { email: string; password: string }) => {
      const res = await user.post("/account/padi", { _csrf: await csrf(), email: diver.email, password: diver.password, units: "metric", timeZone: "UTC" });
      expect(res.headers.get("location")).toBe("/account?m=connected");
    };
    mock.account.certificationPhoto = { status: "APPROVED", data: PNG };

    // 1. A check for one PADI account runs while the user connects another one (without a photo).
    await connect(user);
    let release = mock.holdNext("photo");
    let asked = photoRequests();
    expect(web.ctx.avatars.due(web.ctx.store.getUser(userId())!)).toBe(true);
    expect(await web.ctx.avatars.refresh(web.ctx.store.getUser(userId())!, 0)).toBeUndefined();
    await until(() => photoRequests() === asked + 1);
    await connectNow(OTHER_DIVER);
    // The page does not wait for the old check: it asks PADI for the new account at once.
    const started = Date.now();
    expect((await user.page("/account")).html).not.toContain("/account/avatar");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(photoRequests()).toBe(asked + 2);
    const checked = web.ctx.store.getUser(userId())!;
    expect(checked.avatarCheckedAt).toBeDefined();
    // The old check ends with the first account's photo: it is thrown away.
    release();
    await web.ctx.avatars.idle();
    expect(mock.count("/photo-storage/")).toBeGreaterThan(0);
    expect(web.ctx.store.getAvatar(userId())).toBeUndefined();
    const after = web.ctx.store.getUser(userId())!;
    expect(after.avatarAt).toBeUndefined();
    expect(after.avatarCheckedAt).toBe(checked.avatarCheckedAt);
    expect(after.avatarCheckFailed).toBeUndefined();

    // 2. A check runs while the user removes the PADI connection.
    await connect(user);
    release = mock.holdNext("photo");
    asked = photoRequests();
    await web.ctx.avatars.refresh(web.ctx.store.getUser(userId())!, 0);
    await until(() => photoRequests() === asked + 1);
    expect((await user.post("/account/padi/remove", { _csrf: await csrf() })).status).toBe(303);
    release();
    await web.ctx.avatars.idle();
    expect(web.ctx.store.getAvatar(userId())).toBeUndefined();
    const removed = web.ctx.store.getUser(userId())!;
    expect(removed.avatarAt).toBeUndefined();
    expect(removed.avatarCheckedAt).toBeUndefined();
    expect(removed.avatarCheckFailed).toBeUndefined();
    expect(mock.violations).toEqual([]);
  });

  it("does not ask while the PADI sign-in must be renewed", async () => {
    await connect(user);
    web.ctx.store.markAvatarChecked(userId(), Date.now() - 2 * 86_400_000);
    web.ctx.store.setPadiNeedsReconnect(userId(), true);
    const before = photoRequests();
    await user.page("/account");
    expect(photoRequests()).toBe(before);
    expect(web.ctx.avatars.due(web.ctx.store.getUser(userId())!)).toBe(false);
  });

  it("never asks PADI for a demo account", async () => {
    const reviewer = web.ctx.store.createDemoUser("reviewer@example.com", await hashPassword(PASSWORD));
    const demo = new Browser();
    expect((await demo.login("reviewer@example.com", PASSWORD)).status).toBe(303);
    const before = mock.requests.length;
    const { html } = await demo.page("/account");
    expect(html).not.toContain("/account/avatar");
    expect(mock.requests.length).toBe(before);
    expect(web.ctx.avatars.due(web.ctx.store.getUser(reviewer.id)!)).toBe(false);
    expect(await web.ctx.avatars.refresh(web.ctx.store.getUser(reviewer.id)!)).toBeUndefined();
    expect(mock.requests.length).toBe(before);
  });

  it("deletes the photo with the account", async () => {
    web.ctx.store.createUser("leaving@example.com", await hashPassword(PASSWORD), false);
    const leaving = new Browser();
    expect((await leaving.login("leaving@example.com", PASSWORD)).status).toBe(303);
    await connect(leaving);
    expect((await leaving.page("/account")).html).toContain("/account/avatar?v=");
    const id = web.ctx.store.getUserByEmail("leaving@example.com")!.id;
    expect(web.ctx.store.getAvatar(id)).toBeDefined();
    const { csrf } = await leaving.page("/account/security");
    expect((await leaving.post("/account/delete", { _csrf: csrf, confirm: "leaving@example.com" })).status).toBe(303);
    expect(web.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM avatars WHERE user_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("never writes the secret photo links to the log", () => {
    expect(mock.photoLinks.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    for (const link of mock.photoLinks) {
      expect(all.includes(link)).toBe(false);
      expect(all.includes(new URL(link).searchParams.get("X-Amz-Signature")!)).toBe(false);
      expect(all.includes(new URL(link).pathname)).toBe(false);
    }
    expect(mock.violations).toEqual([]);
  });
});
