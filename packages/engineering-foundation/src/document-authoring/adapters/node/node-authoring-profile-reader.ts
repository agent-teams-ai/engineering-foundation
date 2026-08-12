import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertNotCancelled } from "../../../cancellation.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import type {
  AuthoringProfileReader,
  CatalogCollection,
  CatalogProfileSnapshot
} from "../../application/ports/authoring-profile-reader.js";
import {
  assertAuthoringProfileSemantics,
  AuthoringProfileSemanticError,
  type AuthoringProfileSemantics
} from "../../application/policies/authoring-profile-semantics.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_PROFILE_BYTES = 1024 * 1024;

interface ValidatedProfile {
  readonly catalog: {
    readonly collections: readonly CatalogCollection[];
    readonly excludedPrefixes?: readonly string[];
    readonly metadataSchemaPath: string;
    readonly ownerCatalog: {
      readonly contract: "foundation.owner-map/v1";
      readonly path: string;
    };
  };
  readonly projectId: string;
}

function invalidProfile(error: unknown): never {
  const message = error instanceof Error
    ? error.message.slice(0, 1000)
    : "Document authoring profile is invalid.";
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_INPUT_INVALID",
    `Document authoring profile is invalid: ${message}`,
    { cause: error }
  );
}

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
    assertNotCancelled(request.signal);
    const file = await readDocumentAuthorityFile({
      consumerRoot: request.consumerRoot,
      maxBytes: MAX_PROFILE_BYTES,
      path: request.path
    });
    let input: unknown;
    try {
      assertNotCancelled(request.signal);
      input = parseStrictYamlSource(file.source, "document-authoring-profile");
      await assertSchema(
        "document-authoring-profile/v1",
        input,
        "document-authoring-profile"
      );
      assertAuthoringProfileSemantics(input as AuthoringProfileSemantics);
      assertNotCancelled(request.signal);
    } catch (error) {
      if (
        error instanceof CapabilityInputError ||
        error instanceof AuthoringProfileSemanticError
      ) {
        invalidProfile(error);
      }
      throw error;
    }
    const profile = input as ValidatedProfile;
    return Object.freeze({
      collections: Object.freeze(
        profile.catalog.collections.map(freezeCollection)
      ),
      evidence: file.evidence,
      excludedPrefixes: Object.freeze([
        ...(profile.catalog.excludedPrefixes ?? [])
      ]),
      metadataSchemaPath: profile.catalog.metadataSchemaPath,
      ownerCatalog: Object.freeze({ ...profile.catalog.ownerCatalog }),
      projectId: profile.projectId
    });
  }
}
