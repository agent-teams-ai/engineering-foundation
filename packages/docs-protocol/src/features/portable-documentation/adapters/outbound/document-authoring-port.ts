import type { AuthoringPlan } from "../../application/authoring-observation.js";
import {
  applyDocumentationPlanV2,
  buildDocumentationCatalogV2,
  describeDocumentAuthoringProfileV3,
  findDocumentationDocumentsV2,
  inspectDocumentTransactionV2,
  inspectDocumentAuthoringEnvironmentV1,
  planDocumentationDocumentV2,
  recoverDocumentationTransactionV2,
  type DocumentDescriptorV2,
  type DocumentPlanV2,
  type DocumentMetadataValue
} from "@agent-teams/document-authoring";

import type {
  DocsFindDocument,
} from "../../application/model.js";
import type { DocumentAuthoringDescriptionV2, DocumentAuthoringPortV2 } from "../../application/model-v2.js";
import type { DocumentAuthoringPortV3 } from "../../application/model-v3.js";
import { DocsProfileError } from "../../application/profile-policy.js";
import { normalizeDocumentIds } from "../../domain/document-semantics.js";

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

export class NodeDocumentAuthoringPort implements DocumentAuthoringPortV3 {
  readonly #plans = new WeakMap<AuthoringPlan, DocumentPlanV2>();
  inspectEnvironment(input: Parameters<DocumentAuthoringPortV2["inspectEnvironment"]>[0]) {
    return inspectDocumentAuthoringEnvironmentV1({
      consumerRoot: input.consumerRoot,
      ...signalOption(input.signal)
    });
  }

  async describe(input: Parameters<DocumentAuthoringPortV2["describe"]>[0]): Promise<DocumentAuthoringDescriptionV2> {
    const request = {
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.signal)
    };
    const description = await describeDocumentAuthoringProfileV3(request);
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

  async buildCatalog(input: Parameters<DocumentAuthoringPortV2["buildCatalog"]>[0]) {
    const catalog = await buildDocumentationCatalogV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.signal)
    });
    return Object.freeze({ projectId: catalog.projectId, status: catalog.status, semanticDigest: catalog.semanticDigest, diagnostics: catalog.diagnostics, documents: catalog.documents });
  }

  async find(input: Parameters<DocumentAuthoringPortV2["find"]>[0]): Promise<readonly DocsFindDocument[]> {
    return (await this.findWithEvidence(input)).documents;
  }

  async findWithEvidence(input: Parameters<DocumentAuthoringPortV2["find"]>[0]) {
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
    return Object.freeze({
      catalogSemanticDigest: base.catalogSemanticDigest,
      catalogStatus: base.catalogStatus,
      diagnostics: base.diagnostics,
      documents: Object.freeze(base.documents.map((entry) => projected(entry, "blocked_by")))
    });
  }

  inspect(consumerRoot: string) {
    return inspectDocumentTransactionV2(consumerRoot);
  }

  async plan(input: Parameters<DocumentAuthoringPortV2["plan"]>[0]) {
    const plan = await planDocumentationDocumentV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      intent: input.intent,
      parentPolicy: input.parentPolicy,
      ...signalOption(input.signal)
    });
    const observation = Object.freeze({ schemaVersion: plan.schemaVersion, destination: plan.destination, planDigest: plan.planDigest, output: plan.output, authority: plan.authority });
    this.#plans.set(observation, plan);
    return observation;
  }

  apply(input: Parameters<DocumentAuthoringPortV2["apply"]>[0]) {
    const plan = this.#plans.get(input.plan);
    if (plan === undefined) {throw new DocsProfileError("Document Plan must be applied by its originating authoring adapter.");}
    return applyDocumentationPlanV2({
      consumerRoot: input.consumerRoot,
      plan,
      ...signalOption(input.signal)
    });
  }

  recover(input: Parameters<DocumentAuthoringPortV2["recover"]>[0]) {
    return recoverDocumentationTransactionV2({
      consumerRoot: input.consumerRoot,
      ...signalOption(input.signal)
    });
  }
}
