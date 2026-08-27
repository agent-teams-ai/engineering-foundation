import {
  applyDocumentationPlanV2,
  buildDocumentationCatalogV2,
  describeDocumentAuthoringProfileV2,
  describeDocumentAuthoringProfileV3,
  findDocumentationDocumentsV2,
  inspectDocumentTransactionV2,
  inspectDocumentAuthoringEnvironmentV1,
  planDocumentationDocumentV2,
  recoverDocumentationTransactionV2,
  type DocumentDescriptorV2,
  type DocumentMetadataValue
} from "@agent-teams/engineering-foundation/document-authoring";

import type {
  DocsFindDocument,
} from "../domain/model.js";
import type { FoundationDocsDescriptionV2, FoundationDocsPortV2 } from "../domain/model-v2.js";
import { DocsProfileError } from "../domain/profile-policy.js";
import { normalizeDocumentIds } from "../domain/document-semantics.js";

function stringArray(value: DocumentMetadataValue | undefined, subject: string): readonly string[] {
  if (value === undefined) {return Object.freeze([]);}
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new DocsProfileError(`${subject} must be an array of canonical document IDs.`);
  }
  return normalizeDocumentIds(value, subject);
}

function projected(entry: DocumentDescriptorV2, blockedByKey: string): DocsFindDocument {
  const metadata = entry.metadata;
  return Object.freeze({
    ...entry,
    metadata,
    related: stringArray(metadata["related"], `${entry.id}.related`),
    blockedBy: stringArray(metadata[blockedByKey], `${entry.id}.${blockedByKey}`)
  });
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export class NodeFoundationDocsPort implements FoundationDocsPortV2 {
  inspectEnvironment(input: Parameters<FoundationDocsPortV2["inspectEnvironment"]>[0]) {
    return inspectDocumentAuthoringEnvironmentV1({
      consumerRoot: input.consumerRoot,
      ...signalOption(input.signal)
    });
  }

  async describe(input: Parameters<FoundationDocsPortV2["describe"]>[0]): Promise<FoundationDocsDescriptionV2> {
    const request = {
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.signal)
    };
    const description = input.profileSchemaVersion === 2
      ? await describeDocumentAuthoringProfileV2(request)
      : await describeDocumentAuthoringProfileV3(request);
    return Object.freeze({
      authority: description.authority,
      catalog: description.catalog,
      authorityPaths: Object.freeze([...new Set([
        description.authorityPaths.profile,
        description.authorityPaths.metadataSchema,
        description.authorityPaths.ownerCatalog,
        ...(description.authorityPaths.metadataSidecar === undefined ? [] : [description.authorityPaths.metadataSidecar]),
        ...description.types.map(({ template }) => template.path),
        ...description.types.flatMap(({ reachability }) =>
          reachability.kind === "manual-fixed-index" ? [reachability.indexPath] : [])
      ])].toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))),
      metadataSchemaPath: description.authorityPaths.metadataSchema,
      metadataSidecar: description.authorityPaths.metadataSidecar === undefined
        ? Object.freeze({ kind: "none" as const })
        : Object.freeze({ kind: "path-metadata-map" as const, path: description.authorityPaths.metadataSidecar }),
      ownerIds: description.ownerIds,
      profileSchemaVersion: description.profileSchemaVersion,
      projectId: description.projectId,
      semanticDigest: description.semanticDigest,
      types: description.types
    });
  }

  async buildCatalog(input: Parameters<FoundationDocsPortV2["buildCatalog"]>[0]) {
    return buildDocumentationCatalogV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.signal)
    });
  }

  async find(input: Parameters<FoundationDocsPortV2["find"]>[0]): Promise<readonly DocsFindDocument[]> {
    const base = await findDocumentationDocumentsV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      query: {
        ...(input.query.text === undefined ? {} : { text: input.query.text }),
        filters: {
          ...(input.query.id === undefined ? {} : { id: input.query.id }),
          ...(input.query.owner === undefined ? {} : { owner: input.query.owner }),
          ...(input.query.status === undefined ? {} : { status: input.query.status }),
          ...(input.query.type === undefined ? {} : { type: input.query.type })
        }
      },
      ...signalOption(input.signal)
    });
    return Object.freeze(base.documents.map((entry) => projected(entry, "blocked_by")));
  }

  inspect(consumerRoot: string) {
    return inspectDocumentTransactionV2(consumerRoot);
  }

  plan(input: Parameters<FoundationDocsPortV2["plan"]>[0]) {
    return planDocumentationDocumentV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      intent: input.intent,
      parentPolicy: input.parentPolicy,
      ...signalOption(input.signal)
    });
  }

  apply(input: Parameters<FoundationDocsPortV2["apply"]>[0]) {
    return applyDocumentationPlanV2({
      consumerRoot: input.consumerRoot,
      plan: input.plan,
      ...signalOption(input.signal)
    });
  }

  recover(input: Parameters<FoundationDocsPortV2["recover"]>[0]) {
    return recoverDocumentationTransactionV2({
      consumerRoot: input.consumerRoot,
      ...signalOption(input.signal)
    });
  }
}
