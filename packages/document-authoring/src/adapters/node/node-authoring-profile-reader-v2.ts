import type {
  AuthoringProfileReader,
  CatalogCollection,
  CatalogProfileSnapshot
} from "../../application/ports/authoring-profile-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import { InvalidDocumentAuthoringProfileError } from "./load-validated-document-authoring-profile.js";
import {
  loadValidatedDocumentAuthoringProfileV2,
  resolvedArtifactOwnerIds,
  resolvedProfileMetadataSidecar
} from "./load-validated-document-authoring-profile-v2.js";

function freezeCollection(collection: CatalogCollection): CatalogCollection {
  return collection.kind === "markdown-tree"
    ? Object.freeze({ ...collection })
    : Object.freeze({ ...collection, roots: Object.freeze([...collection.roots]) });
}

export class NodeAuthoringProfileReaderV2 implements AuthoringProfileReader {
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogProfileSnapshot> {
    try {
      const { evidence, profile } = await loadValidatedDocumentAuthoringProfileV2(request);
      const metadataSidecar = resolvedProfileMetadataSidecar(profile);
      return Object.freeze({
        artifactOwnerIds: Object.freeze(
          profile.authoring.artifactTypes.map((artifactType) => {
            return Object.freeze({
              ids: Object.freeze([...(resolvedArtifactOwnerIds(profile, artifactType) ?? [])]),
              type: artifactType.type
            });
          })
        ),
        collections: Object.freeze(profile.catalog.collections.map(freezeCollection)),
        evidence,
        excludedPrefixes: Object.freeze([...(profile.catalog.excludedPrefixes ?? [])]),
        metadataSchemaPath: profile.catalog.metadataSchemaPath,
        ...(metadataSidecar === undefined
          ? {}
          : { metadataSidecar: Object.freeze({ ...metadataSidecar }) }),
        ownerCatalog: Object.freeze({ ...profile.catalog.ownerCatalog }),
        projectId: profile.projectId,
        schemaVersion: profile.schemaVersion,
        templatePaths: Object.freeze(
          profile.authoring.artifactTypes.map((artifactType) => artifactType.template.path)
        )
      });
    } catch (error) {
      if (error instanceof InvalidDocumentAuthoringProfileError) {
        throw new DocumentCatalogError(
          "DOCUMENT_CATALOG_INPUT_INVALID",
          `Document authoring profile is invalid: ${error.message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }
}
