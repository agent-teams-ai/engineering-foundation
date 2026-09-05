import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import type { DocsFindQueryV3 } from "@agent-teams/docs-protocol";

import type { DocsBinding, DocsReader } from "../../application/ports/docs-reader.js";
import { EMPTY_SCHEMA, FIND_SCHEMA, CONTEXT_SCHEMA, QUERY_FIELDS } from "./input-schemas.js";
import { INFO_OUTPUT_SCHEMA, FIND_OUTPUT_SCHEMA, CONTEXT_OUTPUT_SCHEMA } from "./output-schemas.js";
import { projectInfo, projectContext, boundedFindProjection } from "./projections.js";
import { MAX_RESULT_BYTES, DEFAULT_MAX_RESULTS, DEFAULT_CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_MAX_DOCUMENTS, type DocsFindArguments, type DocsContextArguments, type DocsTool, type RegisteredDocsTool } from "./tool-contracts.js";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

function errorResult(code: "CANCELLED" | "DOCS_READ_FAILED" | "RESULT_TOO_LARGE", message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(Object.freeze({ error: Object.freeze({ code, message }) })) }]
  };
}

function successResult(value: Readonly<Record<string, unknown>>): CallToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    return errorResult("RESULT_TOO_LARGE", "The documentation result exceeds the MCP response limit; narrow the query.");
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: value
  };
}

function sanitizedFailure(error: unknown, signal: AbortSignal): CallToolResult {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return errorResult("CANCELLED", "The documentation read was cancelled.");
  }
  return errorResult("DOCS_READ_FAILED", "The documentation read failed.");
}

function queryFrom(arguments_: DocsFindArguments | DocsContextArguments): DocsFindQueryV3 {
  const query: Record<string, string> = {};
  for (const field of QUERY_FIELDS) {
    const value = arguments_[field];
    if (value !== undefined) {query[field] = value;}
  }
  return Object.freeze({
    ...query,
    ...(arguments_.fuzzy === true ? { ranking: "fuzzy-advisory" as const } : {})
  });
}

export function createDocsTools(reader: DocsReader, binding: DocsBinding): readonly [
  DocsTool<Readonly<Record<string, never>>>,
  DocsTool<DocsFindArguments>,
  DocsTool<DocsContextArguments>
] {
  const fixedBinding = Object.freeze({ ...binding });
  const tools: readonly [
    RegisteredDocsTool<Readonly<Record<string, never>>>,
    RegisteredDocsTool<DocsFindArguments>,
    RegisteredDocsTool<DocsContextArguments>
  ] = Object.freeze([
    Object.freeze({
      name: "docs_info" as const,
      description: "Read the fixed consumer's documentation protocol, authority, catalog, owners, and document types.",
      inputSchema: EMPTY_SCHEMA,
      outputSchema: INFO_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      async run(_arguments: Readonly<Record<string, never>>, signal: AbortSignal) {
        try {
          signal.throwIfAborted();
          const execution = await reader.info({ ...fixedBinding, signal });
          return successResult(projectInfo(execution));
        } catch (error: unknown) {
          return sanitizedFailure(error, signal);
        }
      }
    }),
    Object.freeze({
      name: "docs_find" as const,
      description: "Search the fixed consumer's documentation catalog with bounded, read-only filters.",
      inputSchema: FIND_SCHEMA,
      outputSchema: FIND_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      async run(arguments_: DocsFindArguments, signal: AbortSignal) {
        try {
          signal.throwIfAborted();
          const execution = await reader.find({ ...fixedBinding, query: queryFrom(arguments_), signal });
          return successResult(boundedFindProjection(execution, arguments_.maxResults ?? DEFAULT_MAX_RESULTS));
        } catch (error: unknown) {
          return sanitizedFailure(error, signal);
        }
      }
    }),
    Object.freeze({
      name: "docs_context" as const,
      description: "Build bounded llms.txt context from the fixed consumer's documentation with optional filters and advisory fuzzy ranking.",
      inputSchema: CONTEXT_SCHEMA,
      outputSchema: CONTEXT_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      async run(arguments_: DocsContextArguments, signal: AbortSignal) {
        try {
          signal.throwIfAborted();
          const execution = await reader.context({
            ...fixedBinding,
            query: queryFrom(arguments_),
            limits: Object.freeze({
              maxBytes: arguments_.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES,
              maxDocuments: arguments_.maxDocuments ?? DEFAULT_CONTEXT_MAX_DOCUMENTS
            }),
            signal
          });
          return successResult(projectContext(execution));
        } catch (error: unknown) {
          return sanitizedFailure(error, signal);
        }
      }
    })
  ] as const);
  return tools;
}
