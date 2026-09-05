import type { DocumentFileReader } from "../../application/ports/document-file-reader.js";
import type {
  AuthoringProfileReader,
  CatalogCollection,
  CatalogProfileSnapshot
} from "../../application/ports/authoring-profile-reader.js";
import { DocumentCatalogError } from "../../application/model/document-catalog-error.js";
import {
  loadValidatedDocumentAuthoringProfile
} from "./load-validated-document-authoring-profile.js";
import {
  InvalidDocumentAuthoringProfileError} from "../../application/model/validated-document-authoring-profile.js";

function freezeCollection(collection: CatalogCollection): CatalogCollection {
  return collection.kind === "markdown-tree"
    ? Object.freeze({ ...collection })
    : Object.freeze({ ...collection, roots: Object.freeze([...collection.roots]) });
}

export class NodeAuthoringProfileReader implements AuthoringProfileReader {
  constructor(private readonly readFile: DocumentFileReader) {}
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogProfileSnapshot> {
    try {
      const { evidence, profile } = await loadValidatedDocumentAuthoringProfile(this.readFile, request);
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
