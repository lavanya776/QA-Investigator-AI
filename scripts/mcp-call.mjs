#!/usr/bin/env node
/**
 * Generic MCP client for the qa-investigator server (no app-specific logic).
 *
 *   node scripts/mcp-call.mjs --list
 *   node scripts/mcp-call.mjs <tool> '<json args>'
 *   node scripts/mcp-call.mjs <tool> -            (read JSON args from stdin)
 *   node scripts/mcp-call.mjs <tool> @args.json
 *
 * Transport: HTTP to QA_MCP_URL (default http://127.0.0.1:3920/mcp) when a
 * server was started with `npm run mcp:http`; or --stdio to spawn a fresh
 * server process for this single call (browser state is not kept between calls).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const useStdio = argv.includes("--stdio");
const rest = argv.filter((a) => a !== "--stdio");

function readArgs(spec) {
  if (spec === undefined) return {};
  if (spec === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  if (spec.startsWith("@")) return JSON.parse(fs.readFileSync(spec.slice(1), "utf8"));
  return JSON.parse(spec);
}

const transport = useStdio
  ? new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "server.js")], cwd: root, stderr: "ignore" })
  : new StreamableHTTPClientTransport(new URL(process.env.QA_MCP_URL ?? "http://127.0.0.1:3920/mcp"));

const client = new Client({ name: "qa-mcp-call", version: "0.1.0" });
try {
  await client.connect(transport);
  if (rest[0] === "--list" || rest.length === 0) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\n  ${t.description?.slice(0, 160)}…\n  input: ${Object.keys(t.inputSchema.properties ?? {}).join(", ")}${t.outputSchema ? `\n  output: ${Object.keys(t.outputSchema.properties ?? {}).join(", ")}` : ""}`);
  } else {
    const result = await client.callTool({ name: rest[0], arguments: readArgs(rest[1]) }, undefined, { timeout: 300000 });
    for (const c of result.content ?? []) if (c.type === "text") console.log(c.text);
    if (result.isError) process.exitCode = 2;
  }
} catch (err) {
  console.error(`mcp-call failed: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
