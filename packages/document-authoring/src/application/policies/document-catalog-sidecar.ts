import type { MarkdownDocumentObservation } from "../../documentation-observation/application/model/markdown-document.js";
import type {
  DocumentDescriptor,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogDiagnostic
} from "../model/document-catalog.js";
import type {
  CatalogCollection,
  CatalogProfileSnapshot
} from "../ports/authoring-profile-reader.js";
import type { DocumentMetadataSidecarSnapshot } from "../ports/document-metadata-sidecar-reader.js";
import type { MetadataSchemaSnapshot } from "../ports/metadata-instance-validator.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import { catalogDiagnostic } from "./document-catalog-diagnostics.js";
import { inspectDocumentFields } from "./document-catalog-fields.js";
import {
  inspectCatalogDocumentV2,
  type InspectedCatalogDocumentV2
} from "./inspect-catalog-document.js";
import {
  CatalogMetadataProjectionError,
  mergeCatalogMetadata
} from "./project-catalog-metadata.js";

const matchesPrefix = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

function collectionContainsPath(
  collection: CatalogCollection,
  repositoryPath: string
): boolean {
  return collection.kind === "markdown-tree"
    ? matchesPrefix(repositoryPath, collection.root)
    : repositoryPath.split("/").at(-1) === "README.md" &&
        collection.roots.some((root) => matchesPrefix(repositoryPath, root));
}

export function assertSidecarDocumentPaths(
  profile: CatalogProfileSnapshot,
  sidecar: DocumentMetadataSidecarSnapshot
): void {
  const sidecarPath = profile.metadataSidecar?.path;
  const templatePaths = new Set(profile.templatePaths ?? []);
  for (const path of Object.keys(sidecar.documents)) {
    if (
      !profile.collections.some((collection) =>
        collectionContainsPath(collection, path)
      ) ||
      profile.excludedPrefixes.some((prefix) => matchesPrefix(path, prefix)) ||
      templatePaths.has(path) ||
      path === sidecarPath
    ) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_INPUT_INVALID",
        `Document metadata sidecar path is outside the eligible catalog corpus: ${path}.`
      );
    }
  }
}

function sidecarIdentity(
  document: MarkdownDocumentObservation,
  value: unknown
): DocumentIdentityProjectionEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return inspectDocumentFields(
    document,
    value as Record<string, unknown>
  ).identity;
}

export function inspectCatalogDocumentWithSidecar(
  sidecar: DocumentMetadataSidecarSnapshot | undefined,
  document: MarkdownDocumentObservation,
  metadata: MetadataSchemaSnapshot,
  ownerIds: ReadonlySet<string>,
  source: DocumentDescriptor["source"]
): InspectedCatalogDocumentV2 {
  if (sidecar === undefined) {
    return inspectCatalogDocumentV2(document, metadata, ownerIds, source);
  }
  const sidecarMetadata = sidecar.documents[document.repositoryPath];
  if (
    sidecarMetadata === undefined ||
    document.frontmatter.kind === "invalid"
  ) {
    return inspectCatalogDocumentV2(document, metadata, ownerIds, source);
  }
  if (document.frontmatter.kind === "absent") {
    return inspectCatalogDocumentV2(
      document,
      metadata,
      ownerIds,
      source,
      sidecarMetadata
    );
  }
  try {
    return inspectCatalogDocumentV2(
      document,
      metadata,
      ownerIds,
      source,
      mergeCatalogMetadata(document.frontmatter.value, sidecarMetadata)
    );
  } catch (error) {
    if (!(error instanceof CatalogMetadataProjectionError)) {
      throw error;
    }
    const identity = sidecarIdentity(document, sidecarMetadata);
    return Object.freeze({
      diagnostic: catalogDiagnostic(
        "document.catalog.metadata-sidecar-conflict",
        document.repositoryPath,
        error.message
      ),
      ...(identity === undefined ? {} : { identity })
    });
  }
}

export function orphanSidecarDiagnostics(
  sidecar: DocumentMetadataSidecarSnapshot | undefined,
  documents: readonly MarkdownDocumentObservation[]
): readonly DocumentationCatalogDiagnostic[] {
  if (sidecar === undefined) {
    return [];
  }
  const observedPaths = new Set(
    documents.map((document) => document.repositoryPath)
  );
  return Object.keys(sidecar.documents)
    .filter((path) => !observedPaths.has(path))
    .map((path) =>
      catalogDiagnostic(
        "document.catalog.metadata-sidecar-orphan",
        path,
        "Document metadata sidecar path has no discovered Markdown document."
      )
    );
}
