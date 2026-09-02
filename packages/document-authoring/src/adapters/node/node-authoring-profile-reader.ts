import type {
  AuthoringProfileReader,
  CatalogCollection,
  CatalogProfileSnapshot
} from "../../application/ports/authoring-profile-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import {
  InvalidDocumentAuthoringProfileError,
  loadValidatedDocumentAuthoringProfile
} from "./load-validated-document-authoring-profile.js";

function freezeCollection(collection: CatalogCollection): CatalogCollection {
  return collection.kind === "markdown-tree"
    ? Object.freeze({ ...collection })
    : Object.freeze({ ...collection, roots: Object.freeze([...collection.roots]) });
}

export class NodeAuthoringProfileReader implements AuthoringProfileReader {
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogProfileSnapshot> {
    try {
      const { evidence, profile } = await loadValidatedDocumentAuthoringProfile(request);
      return Object.freeze({
        collections: Object.freeze(
          profile.catalog.collections.map(freezeCollection)
        ),
        evidence,
        excludedPrefixes: Object.freeze([
          ...(profile.catalog.excludedPrefixes ?? [])
        ]),
        metadataSchemaPath: profile.catalog.metadataSchemaPath,
        ownerCatalog: Object.freeze({ ...profile.catalog.ownerCatalog }),
        projectId: profile.projectId
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
