import type { CallToolResult, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import type { DocsFindQuery } from "@agent-teams/docs-protocol";

export const DOCS_PROTOCOL_MCP_PROJECTION_VERSION = 1 as const;
export const MAX_RESULT_BYTES = 262_144;
export const DEFAULT_MAX_RESULTS = 25;
export const MAX_RESULTS = 100;
export const DEFAULT_CONTEXT_MAX_BYTES = 32_768;
export const DEFAULT_CONTEXT_MAX_DOCUMENTS = 10;
export const MAX_CONTEXT_BYTES = 131_072;
export const MAX_CONTEXT_DOCUMENTS = 50;
export const MAX_INFO_AUTHORITY_PATHS = 16;
export const MAX_INFO_CATALOG_COLLECTIONS = 16;
export const MAX_INFO_CATALOG_PATHS = 16;
export const MAX_INFO_OWNERS = 32;
export const MAX_INFO_TYPES = 24;
export const MAX_INFO_TYPE_FIELDS = 8;
export const MAX_INFO_VALIDATORS = 32;
export const MAX_FIND_RELATIONS = 8;
export const MAX_FIND_PROJECTION_BYTES = 196_608;

export interface DocsFindArguments extends DocsFindQuery {
  readonly fuzzy?: boolean;
  readonly maxResults?: number;
}

export interface DocsContextArguments extends Omit<DocsFindQuery, "ranking"> {
  readonly fuzzy?: boolean;
  readonly maxBytes?: number;
  readonly maxDocuments?: number;
}

export interface DocsTool<Arguments extends object> {
  readonly name: "docs_context" | "docs_find" | "docs_info";
  readonly description: string;
  readonly inputSchema: StandardSchemaWithJSON<unknown, Arguments>;
  readonly annotations: ToolAnnotations;
  run(arguments_: Arguments, signal: AbortSignal): Promise<CallToolResult>;
}

export interface RegisteredDocsTool<Arguments extends object> extends DocsTool<Arguments> {
  readonly outputSchema: StandardSchemaWithJSON<unknown, Readonly<Record<string, unknown>>>;
}

