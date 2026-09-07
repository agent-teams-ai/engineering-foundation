import {
  markdownSourceWithoutFrontmatter,
  type MarkdownDocumentObservation
} from "../../../documentation-observation/api.js";
import type {
  DocumentDescriptor,
  DocumentDescriptorV2,
  DocumentIdentityProjectionEntry,
  DocumentMetadataObject,
  DocumentationCatalogDiagnostic,
  DocumentSearchCorpusEntry,
  DocumentSearchCorpusEntryV2
} from "../model/document-catalog.js";
import type { MetadataSchemaSnapshot } from "../ports/metadata-instance-validator.js";
import { catalogDiagnostic } from "./document-catalog-diagnostics.js";
import {
  documentTitle,
  inspectDocumentFields,
  invalidDocumentPathInspection
} from "./document-catalog-fields.js";
import {
  CatalogMetadataProjectionError,
  projectCatalogMetadata
} from "./project-catalog-metadata.js";

export interface InspectedCatalogDocument {
  readonly descriptor?: DocumentDescriptor;
  readonly diagnostic?: DocumentationCatalogDiagnostic;
  readonly identity?: DocumentIdentityProjectionEntry;
  readonly searchEntry?: DocumentSearchCorpusEntry;
}

export interface InspectedCatalogDocumentV2 {
  readonly descriptor?: DocumentDescriptorV2;
  readonly diagnostic?: DocumentationCatalogDiagnostic;
  readonly identity?: DocumentIdentityProjectionEntry;
  readonly searchEntry?: DocumentSearchCorpusEntryV2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inspectCatalogDocument(
  document: MarkdownDocumentObservation,
  metadata: MetadataSchemaSnapshot,
  ownerIds: ReadonlySet<string>,
  source: DocumentDescriptor["source"]
): InspectedCatalogDocument {
  if (document.source.startsWith("\uFEFF") || document.source.includes("\u0000")) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.source-invalid",
        document.repositoryPath,
        "Catalog Markdown must not contain a UTF-8 BOM or NUL characters."
      )
    };
  }
  const pathInspection = invalidDocumentPathInspection(document);
  if (pathInspection !== undefined) {
    return pathInspection;
  }
  if (document.frontmatter.kind === "absent") {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.frontmatter-required",
        document.repositoryPath,
        "Catalog documents must contain strict YAML frontmatter."
      )
    };
  }
  if (document.frontmatter.kind === "invalid") {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.frontmatter-invalid",
        document.repositoryPath,
        document.frontmatter.message
      )
    };
  }
  if (!isRecord(document.frontmatter.value)) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.frontmatter-invalid",
        document.repositoryPath,
        "Document frontmatter must be an object."
      )
    };
  }
  const fieldInspection = inspectDocumentFields(
    document,
    document.frontmatter.value
  );
  if (fieldInspection.fields === undefined) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.descriptor-invalid",
        document.repositoryPath,
        "Document metadata must provide bounded id, type, status, owner, and summary strings."
      ),
      ...(fieldInspection.identity === undefined
        ? {}
        : { identity: fieldInspection.identity })
    };
  }
  const { fields, identity } = fieldInspection;
  const validation = metadata.validate(document.frontmatter.value);
  if (!validation.valid) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.metadata-invalid",
        document.repositoryPath,
        validation.messages.join("; ") || "Document metadata is invalid."
      ),
      identity
    };
  }
  if (!ownerIds.has(fields.owner)) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.owner-unknown",
        document.repositoryPath,
        `Document owner is absent from the owner catalog: ${fields.owner}.`
      ),
      identity
    };
  }
  const title = documentTitle(document);
  if (title === undefined) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.title-invalid",
        document.repositoryPath,
        "Catalog documents must contain a bounded level-one heading."
      ),
      identity
    };
  }
  const descriptor: DocumentDescriptor = Object.freeze({
    ...fields,
    repositoryPath: document.repositoryPath,
    source,
    title
  });
  return {
    descriptor,
    identity,
    searchEntry: Object.freeze({
      body: markdownSourceWithoutFrontmatter(document),
      descriptor,
      headings: Object.freeze(document.headings.map((heading) => heading.text))
    })
  };
}

export function inspectCatalogDocumentV2(
  document: MarkdownDocumentObservation,
  metadata: MetadataSchemaSnapshot,
  ownerIds: ReadonlySet<string>,
  source: DocumentDescriptor["source"],
  metadataOverride?: DocumentMetadataObject
): InspectedCatalogDocumentV2 {
  const inspectedDocument = metadataOverride === undefined
    ? document
    : Object.freeze({
        ...document,
        frontmatter: Object.freeze({
          endOffset: document.frontmatter.endOffset,
          kind: "valid" as const,
          value: metadataOverride
        })
      });
  const inspected = inspectCatalogDocument(
    inspectedDocument,
    metadata,
    ownerIds,
    source
  );
  if (inspected.descriptor === undefined || inspected.searchEntry === undefined) {
    return Object.freeze({
      ...(inspected.diagnostic === undefined
        ? {}
        : { diagnostic: inspected.diagnostic }),
      ...(inspected.identity === undefined ? {} : { identity: inspected.identity })
    });
  }
  try {
    const projectedMetadata = projectCatalogMetadata(
      inspectedDocument.frontmatter.kind === "valid"
        ? inspectedDocument.frontmatter.value
        : undefined
    );
    const descriptor: DocumentDescriptorV2 = Object.freeze({
      ...inspected.descriptor,
      metadata: projectedMetadata
    });
    return Object.freeze({
      descriptor,
      ...(inspected.identity === undefined ? {} : { identity: inspected.identity }),
      searchEntry: Object.freeze({
        ...inspected.searchEntry,
        descriptor
      })
    });
  } catch (error) {
    if (!(error instanceof CatalogMetadataProjectionError)) {
      throw error;
    }
    return Object.freeze({
      diagnostic: catalogDiagnostic(
        "document.catalog.metadata-projection-invalid",
        document.repositoryPath,
        error.message
      ),
      ...(inspected.identity === undefined ? {} : { identity: inspected.identity })
    });
  }
}
