import type { DocsReadExecution } from "../../application/ports/docs-reader.js";

import { objectRecord } from "./schema.js";
import { QUERY_FIELDS } from "./input-schemas.js";
import { DOCS_PROTOCOL_MCP_PROJECTION_VERSION, MAX_INFO_AUTHORITY_PATHS, MAX_INFO_CATALOG_COLLECTIONS, MAX_INFO_CATALOG_PATHS, MAX_INFO_OWNERS, MAX_INFO_TYPES, MAX_INFO_TYPE_FIELDS, MAX_INFO_VALIDATORS, MAX_FIND_RELATIONS, MAX_FIND_PROJECTION_BYTES } from "./tool-contracts.js";

function projectExecution(execution: DocsReadExecution, result: unknown): Readonly<Record<string, unknown>> {
  const protocol = objectRecord(execution.envelope.protocol);
  return Object.freeze({
    schemaVersion: DOCS_PROTOCOL_MCP_PROJECTION_VERSION,
    source: Object.freeze({
      protocol: Object.freeze({
        ...(stringValue(protocol.id) === undefined ? {} : { id: protocol.id }),
        ...(typeof protocol.version !== "number" ? {} : { version: protocol.version })
      }),
      command: execution.envelope.command,
      outcome: execution.envelope.outcome,
      exitCode: execution.exitCode
    }),
    diagnostics: projectDiagnostics(execution.envelope.diagnostics),
    result
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : Object.freeze([]);
}

function boundedStrings(value: unknown, maximum: number): Readonly<Record<string, unknown>> {
  const original = stringList(value);
  const items = Object.freeze(original.slice(0, maximum));
  return Object.freeze({
    originalCount: original.length,
    returnedCount: items.length,
    truncated: items.length < original.length,
    items
  });
}

function projectDiagnostics(value: readonly unknown[]): Readonly<Record<string, unknown>> {
  const items = Object.freeze(value.slice(0, 8).map((entry) => {
    const record = objectRecord(entry);
    return Object.freeze({
      ...(stringValue(record.ruleId) === undefined ? {} : { ruleId: record.ruleId }),
      ...(stringValue(record.severity) === undefined ? {} : { severity: record.severity }),
      ...(stringValue(record.phase) === undefined ? {} : { phase: record.phase }),
      ...(stringValue(record.subject) === undefined ? {} : { subject: record.subject }),
      ...(stringValue(record.message) === undefined ? {} : { message: record.message })
    });
  }));
  return Object.freeze({
    originalCount: value.length,
    returnedCount: items.length,
    truncated: items.length < value.length,
    items
  });
}

function projectCatalog(value: unknown): Readonly<Record<string, unknown>> {
  const catalog = objectRecord(value);
  const originalCollections = Array.isArray(catalog.collections) ? catalog.collections : [];
  const collections = Object.freeze(originalCollections.slice(0, MAX_INFO_CATALOG_COLLECTIONS).map((entry) => {
    const collection = objectRecord(entry);
    return Object.freeze({
      ...(stringValue(collection.kind) === undefined ? {} : { kind: collection.kind }),
      ...(stringValue(collection.root) === undefined ? {} : { root: collection.root }),
      roots: boundedStrings(collection.roots, MAX_INFO_CATALOG_PATHS)
    });
  }));
  return Object.freeze({
    collections: Object.freeze({
      originalCount: originalCollections.length,
      returnedCount: collections.length,
      truncated: collections.length < originalCollections.length,
      items: collections
    }),
    excludedPrefixes: boundedStrings(catalog.excludedPrefixes, MAX_INFO_CATALOG_PATHS)
  });
}

export function projectInfo(execution: DocsReadExecution): Readonly<Record<string, unknown>> {
  const result = objectRecord(execution.envelope.result);
  const profile = objectRecord(result.foundationProfile);
  const workflow = objectRecord(result.agentWorkflow);
  const protocol = objectRecord(result.protocol);
  const originalTypes = Array.isArray(result.types) ? result.types : [];
  const types = Object.freeze(originalTypes.slice(0, MAX_INFO_TYPES).map((value) => {
    const type = objectRecord(value);
    return Object.freeze({
      ...(stringValue(type.type) === undefined ? {} : { type: type.type }),
      ...(stringValue(type.initialStatus) === undefined ? {} : { initialStatus: type.initialStatus }),
      allowedOwnerIds: boundedStrings(type.allowedOwnerIds, MAX_INFO_TYPE_FIELDS),
      requiredMetadata: boundedStrings(type.requiredMetadata, MAX_INFO_TYPE_FIELDS)
    });
  }));
  return projectExecution(execution, Object.freeze({
    kind: "info",
    ...(stringValue(result.projectId) === undefined ? {} : { projectId: result.projectId }),
    protocol: Object.freeze({
      ...(stringValue(protocol.id) === undefined ? {} : { id: protocol.id }),
      ...(typeof protocol.version !== "number" ? {} : { version: protocol.version })
    }),
    foundationProfile: Object.freeze({
      ...(typeof profile.schemaVersion !== "number" ? {} : { schemaVersion: profile.schemaVersion }),
      ...(stringValue(profile.path) === undefined ? {} : { path: profile.path }),
      ...(stringValue(profile.metadataSidecarPolicy) === undefined ? {} : { metadataSidecarPolicy: profile.metadataSidecarPolicy })
    }),
    agentWorkflow: Object.freeze({
      ...(stringValue(workflow.skillPath) === undefined ? {} : { skillPath: workflow.skillPath }),
      ...(stringValue(workflow.adoption) === undefined ? {} : { adoption: workflow.adoption })
    }),
    catalog: projectCatalog(result.catalog),
    ...(stringValue(result.semanticDigest) === undefined ? {} : { semanticDigest: result.semanticDigest }),
    ...(stringValue(result.metadataSchemaPath) === undefined ? {} : { metadataSchemaPath: result.metadataSchemaPath }),
    authorityPaths: boundedStrings(result.authorityPaths, MAX_INFO_AUTHORITY_PATHS),
    ownerIds: boundedStrings(result.ownerIds, MAX_INFO_OWNERS),
    types: Object.freeze({
      originalCount: originalTypes.length,
      returnedCount: types.length,
      truncated: types.length < originalTypes.length,
      items: types
    }),
    semanticValidatorIds: boundedStrings(result.semanticValidatorIds, MAX_INFO_VALIDATORS)
  }));
}

function projectFindDocument(value: unknown): Readonly<Record<string, unknown>> {
  const document = objectRecord(value);
  return Object.freeze({
    ...Object.fromEntries(["id", "type", "status", "owner", "title", "summary", "repositoryPath", "source"]
      .flatMap((field) => stringValue(document[field]) === undefined ? [] : [[field, document[field]]])),
    related: boundedStrings(document.related, MAX_FIND_RELATIONS),
    blockedBy: boundedStrings(document.blockedBy, MAX_FIND_RELATIONS)
  });
}

export function projectContext(execution: DocsReadExecution): Readonly<Record<string, unknown>> {
  const result = objectRecord(execution.envelope.result);
  const limits = objectRecord(result.limits);
  const selection = objectRecord(result.selection);
  const selectionQuery = objectRecord(selection.query);
  return projectExecution(execution, Object.freeze({
    kind: "context",
    format: "llms.txt",
    ...(stringValue(result.projectId) === undefined ? {} : { projectId: result.projectId }),
    ...(stringValue(result.catalogSemanticDigest) === undefined ? {} : { catalogSemanticDigest: result.catalogSemanticDigest }),
    selection: Object.freeze({
      ranking: selection.ranking === "fuzzy-advisory" ? "fuzzy-advisory" : "binary-default",
      query: Object.freeze(Object.fromEntries(QUERY_FIELDS.flatMap((field) =>
        stringValue(selectionQuery[field]) === undefined ? [] : [[field, selectionQuery[field]]])))
    }),
    limits: Object.freeze({
      ...(typeof limits.maxBytes !== "number" ? {} : { maxBytes: limits.maxBytes }),
      ...(typeof limits.maxDocuments !== "number" ? {} : { maxDocuments: limits.maxDocuments })
    }),
    ...(typeof result.includedDocuments !== "number" ? {} : { includedDocuments: result.includedDocuments }),
    ...(typeof result.omittedDocuments !== "number" ? {} : { omittedDocuments: result.omittedDocuments }),
    ...(typeof result.truncated !== "boolean" ? {} : { truncated: result.truncated }),
    ...(stringValue(result.content) === undefined ? {} : { content: result.content })
  }));
}

export function boundedFindProjection(execution: DocsReadExecution, maxResults: number): Readonly<Record<string, unknown>> {
  const result = execution.envelope.result;
  if (typeof result !== "object" || result === null || !("documents" in result) || !Array.isArray(result.documents)) {
    return projectExecution(execution, result);
  }
  const originalCount = result.documents.length;
  const documents: Readonly<Record<string, unknown>>[] = [];
  for (const value of result.documents.slice(0, maxResults)) {
    const document = projectFindDocument(value);
    const candidate = projectExecution(execution, Object.freeze({
      kind: "find",
      originalCount,
      returnedCount: documents.length + 1,
      truncated: documents.length + 1 < originalCount,
      documents: Object.freeze([...documents, document])
    }));
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_FIND_PROJECTION_BYTES) {break;}
    documents.push(document);
  }
  return projectExecution(execution, Object.freeze({
    kind: "find",
    originalCount,
    returnedCount: documents.length,
    truncated: documents.length < originalCount,
    documents: Object.freeze(documents)
  }));
}

