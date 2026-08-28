export { CliInputError, parseStartupArguments } from "./cli-input.js";
export type { DocsBinding, DocsReadExecution, DocsReader } from "./contracts.js";
export { NodeDocsReader } from "./node-docs-reader.js";
export { createDocsProtocolMcpServer } from "./server.js";
export {
  createDocsTools,
  DOCS_CONTEXT_OUTPUT_SCHEMA_V1,
  DOCS_ERROR_OUTPUT_SCHEMA_V1,
  DOCS_FIND_OUTPUT_SCHEMA_V1,
  DOCS_INFO_OUTPUT_SCHEMA_V1
} from "./tools.js";
export type { DocsContextArguments, DocsFindArguments, DocsTool } from "./tools.js";
export {
  DOCS_PROTOCOL_MCP_PACKAGE_VERSION,
  DOCS_PROTOCOL_MCP_PROJECTION_VERSION
} from "./version.js";
