import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import {
  canonicalJson,
  sha256Json,
  type CanonicalJsonValue
} from "@agent-teams/repository-mutation";
import type {
  DocumentAuthoringProfileDescriptionV2,
  DocumentAuthoringProfileDescriptionV3
} from "../model/document-authoring-profile-description.js";
import type {
  DocumentAuthorityDigest,
  DocumentDescriptorV2,
  DocumentationCatalogAuthorityV2,
  DocumentationCatalogDiagnostic,
  DocumentationCatalogSnapshotV2,
  DocumentIdentityProjectionEntry
} from "../model/document-catalog.js";
import type {
  DocumentIntent,
  DocumentPlanningProfileSnapshot
} from "../model/document-planning.js";
import { projectCatalogMetadata } from "./project-catalog-metadata.js";
import { selectDocumentArtifact } from "./resolve-document-authoring.js";

const DOMAIN_PREFIX = "agent-teams.foundation.document-authoring";

function domainDigest(
  domain: string,
  payload: CanonicalJsonValue
): DocumentAuthorityDigest {
  return sha256Json({ domain, payload });
}

function canonicalSortKey(value: unknown): string {
  return canonicalJson(value as CanonicalJsonValue);
}

function profileSemanticDigest(
  description:
    | Omit<DocumentAuthoringProfileDescriptionV2, "semanticDigest">
    | Omit<DocumentAuthoringProfileDescriptionV3, "semanticDigest">,
  version: 2 | 3
): DocumentAuthorityDigest {
  const authority = {
    ...description.authority,
    templates: [...description.authority.templates].toSorted(
      (left, right) =>
        compareBinaryStrings(left.type, right.type) ||
        compareBinaryStrings(left.evidence.path, right.evidence.path)
    )
  };
  const catalog = {
    collections: [...description.catalog.collections].toSorted((left, right) =>
      compareBinaryStrings(canonicalSortKey(left), canonicalSortKey(right))
    ),
    excludedPrefixes: [...description.catalog.excludedPrefixes].toSorted(
      compareBinaryStrings
    )
  };
  const payload = {
    ...description,
    authority,
    catalog,
    ownerIds: [...description.ownerIds].toSorted(compareBinaryStrings),
    types: [...description.types].toSorted((left, right) =>
      compareBinaryStrings(left.type, right.type)
    )
  };
  return domainDigest(
    `${DOMAIN_PREFIX}/profile-semantic-projection/v${version}`,
    payload as unknown as CanonicalJsonValue
  );
}

export function documentAuthoringProfileSemanticDigest(
  description: Omit<DocumentAuthoringProfileDescriptionV2, "semanticDigest">
): DocumentAuthorityDigest {
  return profileSemanticDigest(description, 2);
}

export function documentAuthoringProfileSemanticDigestV3(
  description: Omit<DocumentAuthoringProfileDescriptionV3, "semanticDigest">
): DocumentAuthorityDigest {
  return profileSemanticDigest(description, 3);
}

export interface DocumentationCatalogSemanticDigestInput {
  readonly authority: DocumentationCatalogAuthorityV2;
  readonly diagnostics: readonly DocumentationCatalogDiagnostic[];
  readonly documents: readonly DocumentDescriptorV2[];
  readonly identityProjection: readonly DocumentIdentityProjectionEntry[];
  readonly ownerIds: readonly string[];
  readonly projectId: string;
  readonly status: "complete" | "partial";
}

export function documentationCatalogSemanticDigest(
  catalog: DocumentationCatalogSemanticDigestInput
): DocumentAuthorityDigest {
  const payload = {
    authority: catalog.authority,
    diagnostics: [...catalog.diagnostics].toSorted(
      (left, right) =>
        compareBinaryStrings(left.ruleId, right.ruleId) ||
        compareBinaryStrings(left.subject, right.subject) ||
        compareBinaryStrings(left.message, right.message)
    ),
    documents: [...catalog.documents].toSorted(
      (left, right) =>
        compareBinaryStrings(left.repositoryPath, right.repositoryPath) ||
        compareBinaryStrings(left.id, right.id)
    ),
    identityProjection: [...catalog.identityProjection].toSorted(
      (left, right) =>
        compareBinaryStrings(left.id, right.id) ||
        compareBinaryStrings(left.repositoryPath, right.repositoryPath)
    ),
    ownerIds: [...catalog.ownerIds].toSorted(compareBinaryStrings),
    projectId: catalog.projectId,
    schemaVersion: 2,
    status: catalog.status
  };
  return domainDigest(
    `${DOMAIN_PREFIX}/catalog-semantic-projection/v2`,
    payload as unknown as CanonicalJsonValue
  );
}

export interface DocumentationCatalogSemanticTransitionV2 {
  readonly catalogPreimageSemanticDigest: DocumentAuthorityDigest;
  readonly expectedCatalogPostimageSemanticDigest: DocumentAuthorityDigest;
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function catalogDocumentSource(
  profile: DocumentPlanningProfileSnapshot,
  repositoryPath: string
): DocumentDescriptorV2["source"] {
  return profile.collections.some(
    (collection) =>
      collection.kind === "frontmatter-readme" &&
      repositoryPath.endsWith("/README.md") &&
      collection.roots.some((root) => matchesPrefix(repositoryPath, root))
  )
    ? "frontmatter-readme"
    : "markdown-tree";
}

function plannedDocumentDescriptor(input: {
  readonly destination: string;
  readonly intent: DocumentIntent;
  readonly profile: DocumentPlanningProfileSnapshot;
}): DocumentDescriptorV2 {
  const artifact = selectDocumentArtifact(input.profile, input.intent.type);
  const title = artifact.heading.kind === "title"
    ? input.intent.title
    : `${input.intent.id}: ${input.intent.title}`;
  const metadata = projectCatalogMetadata({
    id: input.intent.id,
    owner: input.intent.owner,
    status: artifact.initialStatus,
    summary: input.intent.summary,
    type: input.intent.type,
    ...(input.intent.related === undefined
      ? {}
      : { related: input.intent.related }),
    ...input.intent.additionalMetadata
  });
  return Object.freeze({
    id: input.intent.id,
    metadata,
    owner: input.intent.owner,
    repositoryPath: input.destination,
    source: catalogDocumentSource(input.profile, input.destination),
    status: artifact.initialStatus,
    summary: input.intent.summary,
    title,
    type: input.intent.type
  });
}

function sameGovernedDescriptor(
  left: DocumentDescriptorV2,
  right: DocumentDescriptorV2
): boolean {
  return left.id === right.id &&
    left.owner === right.owner &&
    left.repositoryPath === right.repositoryPath &&
    left.source === right.source &&
    left.status === right.status &&
    left.summary === right.summary &&
    left.title === right.title &&
    left.type === right.type;
}

function digestCatalogProjection(
  catalog: DocumentationCatalogSnapshotV2,
  documents: readonly DocumentDescriptorV2[],
  identityProjection: readonly DocumentIdentityProjectionEntry[]
): DocumentAuthorityDigest {
  return documentationCatalogSemanticDigest({
    authority: catalog.authority,
    diagnostics: catalog.diagnostics,
    documents,
    identityProjection,
    ownerIds: catalog.ownerIds,
    projectId: catalog.projectId,
    status: catalog.status
  });
}

/**
 * Projects the catalog transition caused by publishing one exact v2 Plan.
 * An already-applied exact document is removed only from the logical preimage,
 * which keeps the original Plan reproducible after its publication boundary.
 */
export function projectDocumentationCatalogSemanticTransitionV2(input: {
  readonly catalog: DocumentationCatalogSnapshotV2;
  readonly destination: string;
  readonly intent: DocumentIntent;
  readonly profile: DocumentPlanningProfileSnapshot;
}): DocumentationCatalogSemanticTransitionV2 {
  if (input.catalog.status !== "complete") {
    throw new Error("Catalog semantic transitions require a complete v2 catalog.");
  }
  if (
    documentationCatalogSemanticDigest(input.catalog) !==
    input.catalog.semanticDigest
  ) {
    throw new Error("Catalog semantic transition input does not match its digest.");
  }
  const planned = plannedDocumentDescriptor(input);
  const collisions = input.catalog.documents.filter(
    (document) =>
      document.id === planned.id ||
      document.repositoryPath === planned.repositoryPath
  );
  const exact = collisions.find(
    (document) =>
      document.id === planned.id &&
      document.repositoryPath === planned.repositoryPath
  );
  if (
    collisions.length > (exact === undefined ? 0 : 1) ||
    (exact !== undefined && !sameGovernedDescriptor(exact, planned))
  ) {
    throw new Error(
      "Planned document conflicts with the complete catalog semantic projection."
    );
  }
  const matchingIdentities = input.catalog.identityProjection.filter(
    (identity) =>
      identity.id === planned.id ||
      identity.repositoryPath === planned.repositoryPath
  );
  if (
    matchingIdentities.length !== (exact === undefined ? 0 : 1) ||
    matchingIdentities.some(
      (identity) =>
        identity.id !== planned.id ||
        identity.repositoryPath !== planned.repositoryPath
    )
  ) {
    throw new Error(
      "Planned document identity conflicts with the complete catalog projection."
    );
  }
  const preimageDocuments = exact === undefined
    ? input.catalog.documents
    : input.catalog.documents.filter((document) => document !== exact);
  const preimageIdentities = exact === undefined
    ? input.catalog.identityProjection
    : input.catalog.identityProjection.filter(
        (identity) =>
          identity.id !== planned.id ||
          identity.repositoryPath !== planned.repositoryPath
      );
  const postimageDocuments = exact === undefined
    ? [...input.catalog.documents, planned]
    : input.catalog.documents;
  const postimageIdentities = exact === undefined
    ? [
        ...input.catalog.identityProjection,
        Object.freeze({ id: planned.id, repositoryPath: planned.repositoryPath })
      ]
    : input.catalog.identityProjection;
  return Object.freeze({
    catalogPreimageSemanticDigest: digestCatalogProjection(
      input.catalog,
      preimageDocuments,
      preimageIdentities
    ),
    expectedCatalogPostimageSemanticDigest: digestCatalogProjection(
      input.catalog,
      postimageDocuments,
      postimageIdentities
    )
  });
}
