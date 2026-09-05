import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { CliInputError, parseStartupArguments } from "../adapters/inbound/cli-input.js";
import { NodeDocsReader } from "../adapters/outbound/node-docs-reader.js";
import { createDocsProtocolMcpServer } from "../adapters/inbound/server.js";

import { DOCS_PROTOCOL_MCP_PACKAGE_VERSION } from "../adapters/outbound/installed-package-version.js";

const USAGE = "usage: docs-protocol-mcp --consumer-root PATH [--profile REPOSITORY_RELATIVE_PATH]";

async function main(): Promise<void> {
  const cliArguments = process.argv.slice(2);
  if (cliArguments.length === 1 && cliArguments[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (cliArguments.length === 1 && cliArguments[0] === "--version") {
    process.stdout.write(`${DOCS_PROTOCOL_MCP_PACKAGE_VERSION}\n`);
    return;
  }

  let binding;
  try {
    binding = await parseStartupArguments(cliArguments, process.cwd());
  } catch (error: unknown) {
    const message = error instanceof CliInputError ? error.message : "Startup validation failed.";
    process.stderr.write(`docs-protocol-mcp: ${message}\n`);
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const lifetime = new AbortController();
  const handle = serveStdio(
    () => createDocsProtocolMcpServer(new NodeDocsReader(), binding, lifetime.signal),
    { onerror: () => process.stderr.write("docs-protocol-mcp: MCP transport failed.\n") }
  );
  const shutdown = (): void => {
    lifetime.abort();
    void handle.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function runDocsProtocolMcpCli(): void {
  void main();
}
