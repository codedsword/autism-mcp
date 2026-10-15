#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge.js";
import { loadConfig, syncConfigToBridge } from "./config.js";
import { Context, bound } from "./context.js";
import { buildTools } from "./tools.js";

export function createServer(ctx: Context): McpServer {
  const server = new McpServer({ name: "autism-mcp", version: "0.1.0" });
  for (const t of buildTools(ctx)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: any) => {
      let result;
      try {
        result = await t.handler(args ?? {});
      } catch (e) {
        result = { ok: false, error: { code: "invalid_request", message: (e as Error).message } };
      }
      if (t.kind === "action") ctx.audit(t.name, args, result);
      const payload = bound(result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        isError: !result.ok,
      };
    });
  }
  return server;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  try {
    syncConfigToBridge(cfg);
  } catch (e) {
    console.error("warning: could not sync config.toml to the bridge dir:", (e as Error).message);
  }
  const ctx = new Context(cfg, new BridgeClient(cfg));
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
