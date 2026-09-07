import { isDocumentInputFailure, assertDocumentAuthoringActive } from "../../application/policies/document-input-failure.js";
import type { DocumentFileReader } from "../../application/ports/document-file-reader.js";
import { InvalidDocumentAuthoringProfileError, type ValidatedDocumentAuthoringProfileVersioned } from "../../application/model/validated-document-authoring-profile.js";


import { assertSchema } from "./schema-catalog.js";
import { parseStrictYamlSource } from "./strict-yaml.js";
import {
  assertAuthoringProfileSemantics,
  AuthoringProfileSemanticError,
  type AuthoringProfileSemantics
} from "../../application/policies/authoring-profile-semantics.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_PROFILE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProfile(error: unknown): never {
  const message = error instanceof Error
    ? error.message.slice(0, 1000)
    : "Document authoring profile is invalid.";
  throw new InvalidDocumentAuthoringProfileError(message, { cause: error });
}

function assertVersionedCanonicalStrings(
  input: Record<string, unknown>,
  schemaVersion: 2 | 3
): void {
  const authoring = input["authoring"];
  if (!isRecord(authoring) || !Array.isArray(authoring["artifactTypes"])) {
    throw new TypeError(`Profile v${schemaVersion} authoring.artifactTypes must be an array.`);
  }
  for (const artifactType of authoring["artifactTypes"]) {
    if (!isRecord(artifactType) || !isRecord(artifactType["reachability"])) {
      throw new TypeError(`Profile v${schemaVersion} requires reachability for every artifact type.`);
    }
    const reachability = artifactType["reachability"];
    if (reachability["kind"] !== "not-required") {
      continue;
    }
    const reason = reachability["reason"];
    if (
      typeof reason !== "string" ||
      reason.normalize("NFC") !== reason
    ) {
      throw new TypeError(
        `Profile v${schemaVersion} not-required reachability requires one bounded canonical reason.`
      );
    }
  }
}

export async function loadValidatedDocumentAuthoringProfileV2(readFile: DocumentFileReader, request: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly evidence: Awaited<ReturnType<typeof readDocumentAuthorityFile>>["evidence"];
  readonly profile: ValidatedDocumentAuthoringProfileVersioned;
}> {
  assertDocumentAuthoringActive(request.signal);
  const file = await readDocumentAuthorityFile(readFile, {
    consumerRoot: request.consumerRoot,
    maxBytes: MAX_PROFILE_BYTES,
    path: request.path
  });
  let input: unknown;
  try {
    input = parseStrictYamlSource(file.source, "document-authoring-profile");
    if (!isRecord(input) || ![1, 2, 3].includes(input["schemaVersion"] as number)) {
      throw new TypeError("Document authoring profile schemaVersion must equal 1, 2, or 3.");
    }
    const schemaVersion = input["schemaVersion"];
    if (schemaVersion === 2 || schemaVersion === 3) {
      await assertSchema(
        schemaVersion === 3 ? "document-authoring-profile/v3" : "document-authoring-profile/v2",
        input,
        "document-authoring-profile"
      );
      assertVersionedCanonicalStrings(input, schemaVersion);
    } else {
      await assertSchema(
        "document-authoring-profile/v1",
        input,
        "document-authoring-profile"
      );
    }
    assertAuthoringProfileSemantics(input as unknown as AuthoringProfileSemantics);
    assertDocumentAuthoringActive(request.signal);
  } catch (error) {
    if (
      isDocumentInputFailure(error) ||
      error instanceof AuthoringProfileSemanticError ||
      error instanceof TypeError
    ) {
      invalidProfile(error);
    }
    throw error;
  }
  return Object.freeze({
    evidence: file.evidence,
    profile: input as unknown as ValidatedDocumentAuthoringProfileVersioned
  });
}
