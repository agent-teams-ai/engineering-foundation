import { isDocumentInputFailure, assertDocumentAuthoringActive } from "../../application/policies/document-input-failure.js";
import type { DocumentFileReader } from "../../application/ports/document-file-reader.js";
import { InvalidDocumentAuthoringProfileError, type ValidatedDocumentAuthoringProfile } from "../../application/model/validated-document-authoring-profile.js";


import { assertSchema } from "./schema-catalog.js";
import { parseStrictYamlSource } from "./strict-yaml.js";
import {
  assertAuthoringProfileSemantics,
  AuthoringProfileSemanticError,
  type AuthoringProfileSemantics
} from "../../application/policies/authoring-profile-semantics.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_PROFILE_BYTES = 1024 * 1024;

function invalidProfile(error: unknown): never {
  const message = error instanceof Error
    ? error.message.slice(0, 1000)
    : "Document authoring profile is invalid.";
  throw new InvalidDocumentAuthoringProfileError(message, { cause: error });
}

export async function loadValidatedDocumentAuthoringProfile(readFile: DocumentFileReader, request: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly evidence: Awaited<ReturnType<typeof readDocumentAuthorityFile>>["evidence"];
  readonly profile: ValidatedDocumentAuthoringProfile;
}> {
  assertDocumentAuthoringActive(request.signal);
  const file = await readDocumentAuthorityFile(readFile, {
    consumerRoot: request.consumerRoot,
    maxBytes: MAX_PROFILE_BYTES,
    path: request.path
  });
  let input: unknown;
  try {
    assertDocumentAuthoringActive(request.signal);
    input = parseStrictYamlSource(file.source, "document-authoring-profile");
    await assertSchema(
      "document-authoring-profile/v1",
      input,
      "document-authoring-profile"
    );
    assertAuthoringProfileSemantics(input as AuthoringProfileSemantics);
    assertDocumentAuthoringActive(request.signal);
  } catch (error) {
    if (
      isDocumentInputFailure(error) ||
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
