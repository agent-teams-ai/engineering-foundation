import { McpServer, type ServerContext, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import type { DocsBinding, DocsReader } from "./contracts.js";
import { createDocsTools, type DocsTool } from "./tools.js";
import { DOCS_PROTOCOL_MCP_PACKAGE_VERSION } from "./version.js";

const SERVER_IDENTITY = Object.freeze({
  name: "@agent-teams/docs-protocol-mcp",
  version: DOCS_PROTOCOL_MCP_PACKAGE_VERSION
});

function registerDocsTool<Arguments extends object>(
  server: McpServer,
  tool: DocsTool<Arguments>,
  lifetimeSignal: AbortSignal | undefined
): void {
  const outputSchema = (tool as DocsTool<Arguments> & {
    readonly outputSchema: StandardSchemaWithJSON<unknown, Readonly<Record<string, unknown>>>;
  }).outputSchema;
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema,
    annotations: tool.annotations
  }, async (arguments_: Arguments, context: ServerContext) => {
    const signal = lifetimeSignal === undefined
      ? context.mcpReq.signal
      : AbortSignal.any([context.mcpReq.signal, lifetimeSignal]);
    return tool.run(arguments_, signal);
  });
}

export function createDocsProtocolMcpServer(reader: DocsReader, binding: DocsBinding, lifetimeSignal?: AbortSignal): McpServer {
  const server = new McpServer(SERVER_IDENTITY, { capabilities: { tools: {} } });
  for (const tool of createDocsTools(reader, binding)) {
    registerDocsTool(server, tool, lifetimeSignal);
  }
  return server;
}
