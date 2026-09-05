import type { ContainedFileReader } from "../../../documentation-observation/api.js";
import type {
  DocumentArtifactType,
  DocumentCatalogCollection,
  DocumentIdentityStrategy,
  DocumentPlacementStrategy,
  DocumentPlanningProfileSnapshot
} from "../../application/model/document-planning.js";
import type { DocumentPlanningProfileReader } from "../../application/ports/document-planning-profile-reader.js";
import { DocumentCatalogError } from "../../application/model/document-catalog-error.js";
import { DocumentPlanningError } from "../../application/model/document-planning-error.js";
import { InvalidDocumentAuthoringProfileError, resolvedArtifactOwnerIds, resolvedProfileMetadataSidecar, type ValidatedDocumentAuthoringProfileVersioned } from "../../application/model/validated-document-authoring-profile.js";
import {
  loadValidatedDocumentAuthoringProfileV2} from "./load-validated-document-authoring-profile-v2.js";


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
  artifactType: ValidatedDocumentAuthoringProfileVersioned["authoring"]["artifactTypes"][number],
  profile: ValidatedDocumentAuthoringProfileVersioned
): DocumentArtifactType {
  const allowedOwnerIds = resolvedArtifactOwnerIds(profile, artifactType);
  return Object.freeze({
    ...artifactType,
    ...(allowedOwnerIds === undefined
      ? {}
      : { allowedOwnerIds: Object.freeze([...allowedOwnerIds]) }),
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
  constructor(private readonly readFile: ContainedFileReader) {}
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentPlanningProfileSnapshot> {
    try {
      const { evidence, profile } = await loadValidatedDocumentAuthoringProfileV2(
        this.readFile,
        request
      );
      const metadataSidecar = resolvedProfileMetadataSidecar(profile);
      return Object.freeze({
        artifactTypes: Object.freeze(
          profile.authoring.artifactTypes.map((artifactType) => freezeArtifactType(artifactType, profile))
        ),
        collections: Object.freeze(
          profile.catalog.collections.map(freezeCollection)
        ),
        evidence,
        excludedPrefixes: Object.freeze([
          ...(profile.catalog.excludedPrefixes ?? [])
        ]),
        metadataSchemaPath: profile.catalog.metadataSchemaPath,
        ...(metadataSidecar === undefined
          ? {}
          : { metadataSidecar: Object.freeze({ ...metadataSidecar }) }),
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
