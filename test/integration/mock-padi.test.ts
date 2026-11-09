/**
 * End-to-end tests against an in-process mock PADI API (Cognito and the logbook GraphQL), with the
 * built server (dist/index.js) over stdio and in web mode. Nothing is ever sent to PADI.
 *
 *   npm run build
 *   PADI_MCP_IT=1 npm run test:integration
 *
 * e2e.test.ts covers the services in process and the PADI client in detail; web-e2e.test.ts covers
 * the web service in process. This file checks the built program as a user starts it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_ACCOUNT, startMockPadi, type MockPadi } from "../helpers/mock-padi.js";
import { Browser, connectMcp, setBase, TestOAuthClient } from "../helpers/web-client.js";

const enabled = process.env.PADI_MCP_IT === "1";

/** The tools of DESIGN.md section 6 and their kinds. */
const KINDS: Record<string, string> = {
  padi_account_info: "read",
  logbook_list_dives: "read",
  logbook_get_dive: "read",
  logbook_stats: "read",
  logbook_search_dive_sites: "read",
  logbook_export_dives: "read",
  logbook_lookup_instructor: "read",
  padi_list_certifications: "read",
  logbook_get_photos: "read",
  logbook_create_dive: "write",
  logbook_update_dive: "write, idempotent",
  logbook_set_units: "write, idempotent",
  logbook_submit_for_verification: "write, openWorld",
  logbook_delete_dive: "destructive",
};

/** The kind of a tool, read back from its annotations. */
function kindOf(a: ToolAnnotations | undefined): string {
  if (a?.readOnlyHint) return a.idempotentHint && !a.destructiveHint && !a.openWorldHint ? "read" : "read?";
  if (a?.destructiveHint) return "destructive";
  return ["write", ...(a?.idempotentHint ? ["idempotent"] : []), ...(a?.openWorldHint ? ["openWorld"] : [])].join(", ");
}

type Content = Array<{ type: string; text?: string }>;

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Content).map((c) => c.text ?? "").join(" ");
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse((res.content as Content)[0]!.text!) as T;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Wait until a child process prints a line that contains `text` on stderr. */
function waitForLog(child: ChildProcess, text: string, output: { stderr: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${text}" in time. Output so far:\n${output.stderr}`)), 20_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
      if (output.stderr.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code}:\n${output.stderr}`));
    });
  });
}

describe.skipIf(!enabled)("against a mock PADI API", () => {
  let mock: MockPadi;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    mock = await startMockPadi();
  });

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await mock?.close();
  });

  /** A client of the built server over stdio, and what the server wrote to stderr. */
  async function stdio(extra: Record<string, string> = {}): Promise<{ client: Client; stderr: () => string }> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { PATH: process.env.PATH ?? "", PADI_EMAIL: MOCK_ACCOUNT.email, PADI_PASSWORD: MOCK_ACCOUNT.password, PADI_TIMEZONE: "Europe/Zurich", ...mock.env(), ...extra },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: "it-stdio", version: "1.0.0" });
    await client.connect(transport);
    return { client, stderr: () => stderr };
  }

  it("signs in, lists, creates, updates and deletes dives over stdio", async () => {
    const before = mock.requests.length;
    const { client, stderr } = await stdio();
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "padi-mcp", title: "MCP for PADI (dive logbook)" });
      const { tools } = await client.listTools();
      expect(Object.fromEntries(tools.map((t) => [t.name, kindOf(t.annotations)]))).toEqual(KINDS);

      const info = await call(client, "padi_account_info", { check: true });
      expect(info).toMatchObject({ name: "River Tester", affiliate_id: MOCK_ACCOUNT.affiliateId, read_only: false, demo: false, check: { ok: true, dives: 25 } });

      const first = await call<{ total: number; dives: Array<{ id: number }> }>(client, "logbook_list_dives", { limit: 5 });
      expect(first.total).toBe(25);
      expect(first.dives).toHaveLength(5);

      const created = await call<{ id: number; title: string; status: string; dive_type: string }>(client, "logbook_create_dive", {
        title: "Stdio wall",
        date: "2026-10-28",
        location: "Lantern Reef",
        dive_type: "boat",
        max_depth: 24.5,
        bottom_time_min: 38,
        visibility: "High",
        feeling: "Amazing",
      });
      expect(created).toMatchObject({ title: "Stdio wall", status: "Publish", dive_type: "Boat" });
      expect(mock.account.store.logs.get(created.id)).toMatchObject({ dive_title: "Stdio wall", dive_date: "2026-10-28T00:00:00" });

      const read = await call(client, "logbook_get_dive", { dive_id: created.id });
      expect(read).toMatchObject({ id: created.id, max_depth: 24.5, bottom_time_min: 38, visibility: "High", feeling: "Amazing", locked: false });

      const updated = await call(client, "logbook_update_dive", { dive_id: created.id, title: "Stdio wall, north side", notes: "Turtle at 20 m", feeling: null });
      expect(updated).toMatchObject({ title: "Stdio wall, north side", notes: "Turtle at 20 m", max_depth: 24.5, visibility: "High" });
      expect(updated).not.toHaveProperty("feeling");
      expect(mock.account.store.logs.get(created.id)!.dive_title).toBe("Stdio wall, north side");
      expect((await call<{ total: number }>(client, "logbook_list_dives", { limit: 1 })).total).toBe(26);

      const deleted = await call<{ deleted: boolean }>(client, "logbook_delete_dive", { dive_id: created.id, confirm_title: "stdio wall, north side" });
      expect(deleted.deleted).toBe(true);
      expect(mock.account.store.logs.has(created.id)).toBe(false);
      expect((await call<{ total: number }>(client, "logbook_list_dives", { limit: 1 })).total).toBe(25);

      // One password sign-in for the whole session, and every query scoped to this diver.
      expect(mock.requests.slice(before).filter((r) => r.body.includes("USER_PASSWORD_AUTH"))).toHaveLength(1);
      expect(mock.violations).toEqual([]);
    } finally {
      await client.close();
    }
    // The log never shows the password, a token or the e-mail address.
    expect(stderr()).toContain("ready (stdio)");
    expect(stderr()).not.toContain(MOCK_ACCOUNT.password);
    expect(stderr()).not.toContain(MOCK_ACCOUNT.email);
    expect(stderr()).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
  });

  it("offers only the read tools in read-only mode", async () => {
    const { client } = await stdio({ PADI_READ_ONLY: "true" });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(KINDS).filter((n) => KINDS[n] === "read").sort());
      expect(await call(client, "padi_account_info")).toMatchObject({ read_only: true });
    } finally {
      await client.close();
    }
  });

  it("serves a web user with their own PADI connection", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const dataDir = mkdtempSync(join(tmpdir(), "padi-mcp-web-it-"));
    const admin = { email: "admin@example.com", password: "a long invented admin password" };
    const child = spawn(process.execPath, ["dist/index.js", "--web", "--port", String(port)], {
      env: { PATH: process.env.PATH ?? "", DATA_DIR: dataDir, PUBLIC_URL: base, ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password, ...mock.env() },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    const output = { stderr: "" };
    await waitForLog(child, "Web mode listening", output);
    setBase(base);

    // The administrator signs in and connects their PADI account with "Save and test".
    const browser = new Browser();
    expect((await browser.login(admin.email, admin.password)).status).toBe(303);
    const { csrf } = await browser.page("/account");
    const saved = await browser.post("/account/padi", { _csrf: csrf, email: MOCK_ACCOUNT.email, password: MOCK_ACCOUNT.password, units: "metric" });
    expect(saved.headers.get("location")).toBe("/account?m=connected");
    const page = await browser.page("/account?m=connected");
    expect(page.html).toContain("Connected to PADI.");
    expect(page.html).toContain("River Tester");
    expect(page.html).toContain(MOCK_ACCOUNT.affiliateId);
    expect(page.html).not.toContain(MOCK_ACCOUNT.password);

    // Then connects like Claude (OAuth) and uses the logbook.
    const client = await connectMcp(new TestOAuthClient(browser));
    try {
      expect(await call(client, "padi_account_info")).toMatchObject({ name: "River Tester", affiliate_id: MOCK_ACCOUNT.affiliateId, demo: false });
      const before = await call<{ total: number }>(client, "logbook_list_dives", { limit: 1 });
      expect(before.total).toBe(mock.account.store.sorted().length);
      const created = await call<{ id: number }>(client, "logbook_create_dive", {
        title: "Web wall",
        date: "2026-10-29",
        location: "Eel Garden",
        dive_type: "Boat",
        max_depth: 16,
        bottom_time_min: 52,
      });
      expect(mock.account.store.logs.get(created.id)!.dive_title).toBe("Web wall");
      // An expired ID token is renewed with the stored refresh token.
      mock.expireIdTokens();
      await call(client, "logbook_delete_dive", { dive_id: created.id, confirm_title: "Web wall" });
      expect((await call<{ total: number }>(client, "logbook_list_dives", { limit: 1 })).total).toBe(before.total);
      expect(mock.violations).toEqual([]);
    } finally {
      await client.close();
    }

    // The database never holds the PADI password, and holds the refresh token only encrypted.
    const refresh = mock.requests.find((r) => r.body.includes("REFRESH_TOKEN_AUTH"));
    expect(refresh).toBeDefined();
    const refreshToken = JSON.parse(refresh!.body).AuthParameters.REFRESH_TOKEN as string;
    expect(refreshToken.length).toBeGreaterThan(10);
    const stored = readdirSync(dataDir)
      .map((name) => readFileSync(join(dataDir, name)).toString("latin1"))
      .join("\n");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(MOCK_ACCOUNT.password);
    expect(stored).not.toContain(refreshToken);
    // And the log does not show the PADI password, tokens or e-mail addresses.
    expect(output.stderr).not.toContain(MOCK_ACCOUNT.password);
    expect(output.stderr).not.toContain(MOCK_ACCOUNT.email);
    expect(output.stderr).not.toContain(admin.email);
    expect(output.stderr).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
  });
});
