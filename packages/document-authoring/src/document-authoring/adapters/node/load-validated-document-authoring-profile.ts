import { CapabilityInputError, assertNotCancelled, type ContainedFileReader } from "../../../documentation-observation/api.js";
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

export async function loadValidatedDocumentAuthoringProfile(readFile: ContainedFileReader, request: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly evidence: Awaited<ReturnType<typeof readDocumentAuthorityFile>>["evidence"];
  readonly profile: ValidatedDocumentAuthoringProfile;
}> {
  assertNotCancelled(request.signal);
  const file = await readDocumentAuthorityFile(readFile, {
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
