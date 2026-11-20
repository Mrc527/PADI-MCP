/**
 * The MCP surface (server info, instructions, tools with their schemas and annotations, prompts)
 * stays what AI apps saw before the move to mcp-use. test/fixtures/mcp-surface.json was recorded
 * from the MCP SDK server; after an intended change, rerun with UPDATE_MCP_SURFACE=1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { DemoLogbookStore } from "../../src/demo/logbook.js";
import { createMcpServer, createServices } from "../../src/server.js";
import { VERSION } from "../../src/version.js";
import { connectClient } from "../helpers/mcp-client.js";

const FIXTURE = new URL("../fixtures/mcp-surface.json", import.meta.url);

/** Drops the JSON Schema dialect ($schema) and the MCP SDK's task metadata (execution): not part of the contract. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "$schema" && k !== "execution").map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

async function surface(extra: Record<string, string>) {
  const config = loadConfig({ PADI_EMAIL: "diver.test@example.com", PADI_PASSWORD: "not-a-real-password", PADI_TIMEZONE: "Europe/Zurich", ...extra });
  const client = await connectClient(createMcpServer(config, createServices(config, { demo: new DemoLogbookStore() }), () => {}));
  try {
    const { icons: _icons, version, ...serverInfo } = client.getServerVersion()!;
    expect(version).toBe(VERSION);
    return {
      serverInfo,
      instructions: client.getInstructions(),
      tools: normalize((await client.listTools()).tools),
      prompts: normalize((await client.listPrompts()).prompts),
    };
  } finally {
    await client.close();
  }
}

describe("MCP surface", () => {
  it("is unchanged for a writable and a read-only account", async () => {
    const current = { writable: await surface({}), read_only: await surface({ PADI_READ_ONLY: "true" }) };
    if (process.env.UPDATE_MCP_SURFACE === "1") writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
    expect(current).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("declares every tool input schema strict and as an object", async () => {
    const { tools } = await surface({});
    for (const tool of tools as Array<{ name: string; inputSchema: { type: string; additionalProperties?: unknown } }>) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});

describe("mcp-use usage events", () => {
  it("are off: nothing is sent and no .mcp-use directory is written", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "padi-mcp-usage-"));
    const cwd = process.cwd();
    const nodeEnv = process.env.NODE_ENV;
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    // Records every outside request and never lets one leave the machine.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://localhost/")) return realFetch(input, init);
      sent.push(url);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    // mcp-use never records usage under NODE_ENV=test, which would hide the switch.
    process.env.NODE_ENV = "production";
    process.chdir(dir);
    try {
      expect(globalThis.__MCP_USE_ANONYMIZED_TELEMETRY__).toBe(false);
      const config = loadConfig({ PADI_EMAIL: "diver.test@example.com", PADI_PASSWORD: "not-a-real-password", PADI_TIMEZONE: "Europe/Zurich" });
      const client = await connectClient(createMcpServer(config, createServices(config, { demo: new DemoLogbookStore() }), () => {}));
      await client.listTools();
      await client.callTool({ name: "logbook_list_dives", arguments: { limit: 1 } });
      await client.close();
      await new Promise((r) => setTimeout(r, 200));
      expect(sent).toEqual([]);
      expect(existsSync(join(dir, ".mcp-use"))).toBe(false);
    } finally {
      process.chdir(cwd);
      process.env.NODE_ENV = nodeEnv;
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
