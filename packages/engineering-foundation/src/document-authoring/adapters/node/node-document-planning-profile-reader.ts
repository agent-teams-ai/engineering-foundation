import type {
  DocumentArtifactType,
  DocumentCatalogCollection,
  DocumentIdentityStrategy,
  DocumentPlacementStrategy,
  DocumentPlanningProfileSnapshot
} from "../../application/model/document-planning.js";
import type { DocumentPlanningProfileReader } from "../../application/ports/document-planning-profile-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import { DocumentPlanningError } from "../../document-planning-error.js";
import {
  InvalidDocumentAuthoringProfileError
} from "./load-validated-document-authoring-profile.js";
import {
  loadValidatedDocumentAuthoringProfileV2,
  type ValidatedDocumentAuthoringProfileV2
} from "./load-validated-document-authoring-profile-v2.js";

function freezeIdentity(identity: DocumentIdentityStrategy): DocumentIdentityStrategy {
  return identity.format === "qualified"
    ? Object.freeze({
        ...identity,
        grammar: Object.freeze({
          ...identity.grammar,
          prefixSegments: Object.freeze([...identity.grammar.prefixSegments])
        })
      })
    : Object.freeze({ ...identity });
}

function freezePlacement(placement: DocumentPlacementStrategy): DocumentPlacementStrategy {
  return placement.kind === "explicit"
    ? Object.freeze({
        ...placement,
        allowedRoots: Object.freeze([...placement.allowedRoots]),
        requiredSegmentsInOrder: Object.freeze([
          ...placement.requiredSegmentsInOrder
        ])
      })
    : Object.freeze({ ...placement });
}

function freezeArtifactType(
  artifactType: ValidatedDocumentAuthoringProfileV2["authoring"]["artifactTypes"][number]
): DocumentArtifactType {
  return Object.freeze({
    ...artifactType,
    ...(artifactType.allowedOwnerIds === undefined
      ? {}
      : { allowedOwnerIds: Object.freeze([...artifactType.allowedOwnerIds]) }),
    heading: Object.freeze({ ...artifactType.heading }),
    identity: freezeIdentity(artifactType.identity),
    placement: freezePlacement(artifactType.placement),
    reachability: Object.freeze({
      ...(artifactType.reachability ?? { kind: "not-required" })
    }),
    template: Object.freeze({ ...artifactType.template })
  });
}

function freezeCollection(
  collection: DocumentCatalogCollection
): DocumentCatalogCollection {
  return collection.kind === "frontmatter-readme"
    ? Object.freeze({ ...collection, roots: Object.freeze([...collection.roots]) })
    : Object.freeze({ ...collection });
}

function invalidProfile(error: InvalidDocumentAuthoringProfileError): never {
  throw new DocumentPlanningError(
    "DOCUMENT_PLANNING_INPUT_INVALID",
    `Document authoring profile is invalid: ${error.message}`,
    { cause: error }
  );
}

export class NodeDocumentPlanningProfileReader
implements DocumentPlanningProfileReader {
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentPlanningProfileSnapshot> {
    try {
      const { evidence, profile } = await loadValidatedDocumentAuthoringProfileV2(
        request
      );
      return Object.freeze({
        artifactTypes: Object.freeze(
          profile.authoring.artifactTypes.map(freezeArtifactType)
        ),
        collections: Object.freeze(
          profile.catalog.collections.map(freezeCollection)
        ),
        evidence,
        excludedPrefixes: Object.freeze([
          ...(profile.catalog.excludedPrefixes ?? [])
        ]),
        metadataSchemaPath: profile.catalog.metadataSchemaPath,
        ...(profile.catalog.metadataSidecar === undefined
          ? {}
          : { metadataSidecar: Object.freeze({ ...profile.catalog.metadataSidecar }) }),
        ownerCatalog: Object.freeze({ ...profile.catalog.ownerCatalog }),
        projectId: profile.projectId,
        schemaVersion: profile.schemaVersion
      });
    } catch (error) {
      if (error instanceof InvalidDocumentAuthoringProfileError) {
        invalidProfile(error);
      }
      if (error instanceof DocumentCatalogError) {
        throw new DocumentPlanningError(
          error.code === "DOCUMENT_CATALOG_INPUT_INVALID"
            ? "DOCUMENT_PLANNING_INPUT_INVALID"
            : "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
          `Document authoring profile cannot be loaded: ${error.message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }
}
