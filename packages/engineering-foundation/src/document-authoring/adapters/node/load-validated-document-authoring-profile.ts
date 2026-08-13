import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertNotCancelled } from "../../../cancellation.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import type {
  DocumentArtifactType,
  DocumentCatalogCollection
} from "../../application/model/document-planning.js";
import {
  assertAuthoringProfileSemantics,
  AuthoringProfileSemanticError,
  type AuthoringProfileSemantics
} from "../../application/policies/authoring-profile-semantics.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_PROFILE_BYTES = 1024 * 1024;

export interface ValidatedDocumentAuthoringProfile {
  readonly authoring: {
    readonly artifactTypes: readonly DocumentArtifactType[];
    readonly mode: "create-only";
  };
  readonly catalog: {
    readonly collections: readonly DocumentCatalogCollection[];
    readonly excludedPrefixes?: readonly string[];
    readonly metadataSchemaPath: string;
    readonly ownerCatalog: {
      readonly contract: "foundation.owner-map/v1";
      readonly path: string;
    };
  };
  readonly projectId: string;
  readonly schemaVersion: 1;
}

export class InvalidDocumentAuthoringProfileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidDocumentAuthoringProfileError";
  }
}

function invalidProfile(error: unknown): never {
  const message = error instanceof Error
    ? error.message.slice(0, 1000)
    : "Document authoring profile is invalid.";
  throw new InvalidDocumentAuthoringProfileError(message, { cause: error });
}

export async function loadValidatedDocumentAuthoringProfile(request: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly evidence: Awaited<ReturnType<typeof readDocumentAuthorityFile>>["evidence"];
  readonly profile: ValidatedDocumentAuthoringProfile;
}> {
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
  return Object.freeze({
    evidence: file.evidence,
    profile: input as ValidatedDocumentAuthoringProfile
  });
}
