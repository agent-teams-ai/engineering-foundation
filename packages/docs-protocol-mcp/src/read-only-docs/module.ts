export { CliInputError, parseStartupArguments } from "./adapters/inbound/cli-input.js";
export type { DocsBinding, DocsReadExecution, DocsReader } from "./application/ports/docs-reader.js";
export { NodeDocsReader } from "./adapters/outbound/node-docs-reader.js";
export { createDocsProtocolMcpServer } from "./adapters/inbound/server.js";
export {
  DOCS_CONTEXT_OUTPUT_SCHEMA_V1,
  DOCS_ERROR_OUTPUT_SCHEMA_V1,
  DOCS_FIND_OUTPUT_SCHEMA_V1,
  DOCS_INFO_OUTPUT_SCHEMA_V1
} from "./adapters/inbound/output-schemas.js";
export type { DocsContextArguments, DocsFindArguments, DocsTool } from "./adapters/inbound/tool-contracts.js";
export { createDocsTools } from "./adapters/inbound/tools.js";
export { DOCS_PROTOCOL_MCP_PACKAGE_VERSION } from "./adapters/outbound/installed-package-version.js";
export { DOCS_PROTOCOL_MCP_PROJECTION_VERSION } from "./adapters/inbound/tool-contracts.js";
export { runDocsProtocolMcpCli } from "./composition/stdio-cli.js";
