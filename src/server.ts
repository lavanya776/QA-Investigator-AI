#!/usr/bin/env node
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools/register.js";
import { engine } from "./browser/engine.js";

const INSTRUCTIONS = `QA Investigator: evidence-driven investigation tools. You (the model) do the reasoning; these tools execute and record.
Workflow: start_mission (authorised scope) -> understand the app (inspect_page, docs, investigate_api on documented endpoints) -> manage_coverage add_requirements/add_areas/add_scenarios (risk-based plan) -> execute with interact_with_page / investigate_api / capture_evidence -> record_finding (evidence required) -> verify_finding -> manage_coverage record_results -> generate_qa_report.
Rules: never invent requirements or evidence; findings start Potential and only verification confirms them; record blocked/not-tested work with reasons; stop and ask the user when scope or authorisation is unclear.`;

function createServer(): McpServer {
  const server = new McpServer({ name: "qa-investigator", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const httpIdx = process.argv.indexOf("--http");
  if (httpIdx >= 0) {
    // Optional localhost Streamable HTTP transport (stateless). Tool state lives in
    // module singletons, so browser sessions persist across requests.
    const port = Number(process.argv[httpIdx + 1] ?? 3920);
    const httpServer = http.createServer(async (req, res) => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    httpServer.listen(port, "127.0.0.1", () => console.error(`qa-investigator MCP (streamable HTTP) on http://127.0.0.1:${port}/mcp`));
  } else {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error("qa-investigator MCP server running on stdio");
  }

  const shutdown = async () => {
    await engine.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", () => {
    if (httpIdx < 0) void shutdown();
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
