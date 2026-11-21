/**
 * The MCP surface (server info, instructions, tools with their schemas and annotations, prompts)
 * stays what AI apps saw from the MCP SDK v1 server, on 2025-era connections and on the
 * 2026-07-28 protocol. test/fixtures/mcp-surface.json was recorded from the v1 server; after an
 * intended change, rerun with UPDATE_MCP_SURFACE=1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { DemoLogbookStore } from "../../src/demo/logbook.js";
import { createMcpServer, createServices } from "../../src/server.js";
import { VERSION } from "../../src/version.js";
import { connectClient, connectModernClient } from "../helpers/mcp-client.js";

const FIXTURE = new URL("../fixtures/mcp-surface.json", import.meta.url);

/** Drops the JSON Schema dialect ($schema) and the SDK's task metadata (execution): not part of the contract. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "$schema" && k !== "execution").map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function serverFor(extra: Record<string, string>) {
  const config = loadConfig({ PADI_EMAIL: "diver.test@example.com", PADI_PASSWORD: "not-a-real-password", PADI_TIMEZONE: "Europe/Zurich", ...extra });
  const services = createServices(config, { demo: new DemoLogbookStore() });
  return () => createMcpServer(config, services, () => {});
}

async function surfaceOf(client: Client) {
  const { icons: _icons, version, ...serverInfo } = client.getServerVersion()!;
  expect(version).toBe(VERSION);
  return {
    serverInfo,
    instructions: client.getInstructions(),
    tools: normalize((await client.listTools()).tools),
    prompts: normalize((await client.listPrompts()).prompts),
  };
}

async function legacySurface(extra: Record<string, string>) {
  const client = await connectClient(serverFor(extra)());
  try {
    return await surfaceOf(client);
  } finally {
    await client.close();
  }
}

async function modernSurface(extra: Record<string, string>) {
  const { client, close } = await connectModernClient(serverFor(extra));
  try {
    return await surfaceOf(client);
  } finally {
    await close();
  }
}

describe("MCP surface", () => {
  it("is unchanged for a writable and a read-only account on a 2025-era connection", async () => {
    const current = { writable: await legacySurface({}), read_only: await legacySurface({ PADI_READ_ONLY: "true" }) };
    if (process.env.UPDATE_MCP_SURFACE === "1") writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
    expect(current).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("is the same on the 2026-07-28 protocol", async () => {
    const current = { writable: await modernSurface({}), read_only: await modernSurface({ PADI_READ_ONLY: "true" }) };
    expect(current).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("declares every tool input schema strict and as an object", async () => {
    const { tools } = await legacySurface({});
    for (const tool of tools as Array<{ name: string; inputSchema: { type: string; additionalProperties?: unknown } }>) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});
