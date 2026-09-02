import { CapabilityInputError } from "../../capability-runtime.js";
import { assertNotCancelled } from "../../cancellation.js";
import { assertSchema } from "../../schema-catalog.js";
import { parseStrictYamlSource } from "../../strict-yaml.js";
import {
  assertAuthoringProfileSemantics,
  AuthoringProfileSemanticError,
  type AuthoringProfileSemantics
} from "../../application/policies/authoring-profile-semantics.js";
import {
  InvalidDocumentAuthoringProfileError,
  type ValidatedDocumentAuthoringProfile
} from "./load-validated-document-authoring-profile.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_PROFILE_BYTES = 1024 * 1024;

export interface ValidatedDocumentAuthoringProfileV2
  extends Omit<
    ValidatedDocumentAuthoringProfile,
    "authoring" | "catalog" | "schemaVersion"
  > {
  readonly authoring: {
    readonly artifactTypes: readonly (
      ValidatedDocumentAuthoringProfile["authoring"]["artifactTypes"][number] & {
        readonly allowedOwnerIds: readonly string[];
      }
    )[];
    readonly mode: "create-only";
  };
  readonly catalog: ValidatedDocumentAuthoringProfile["catalog"] & {
    readonly metadataSidecar?: {
      readonly kind: "path-metadata-map";
      readonly path: string;
    };
  };
  readonly schemaVersion: 2;
}

export interface ValidatedDocumentAuthoringProfileV3
  extends Omit<
    ValidatedDocumentAuthoringProfile,
    "authoring" | "catalog" | "schemaVersion"
  > {
  readonly authoring: {
    readonly artifactTypes: readonly (
      ValidatedDocumentAuthoringProfile["authoring"]["artifactTypes"][number] & (
        | {
            readonly allowedOwnerIds: readonly string[];
            readonly ownerSetId?: never;
          }
        | {
            readonly allowedOwnerIds?: never;
            readonly ownerSetId: string;
          }
      )
    )[];
    readonly mode: "create-only";
    readonly ownerSets?: {
      readonly schemaVersion: 1;
      readonly sets: Readonly<Record<string, readonly string[]>>;
    };
  };
  readonly catalog: ValidatedDocumentAuthoringProfile["catalog"] & {
    readonly metadataSidecar?: {
      readonly kind: "path-metadata-map";
      readonly path: string;
    };
  };
  readonly schemaVersion: 3;
}

export type ValidatedDocumentAuthoringProfileVersioned =
  | ValidatedDocumentAuthoringProfile
  | ValidatedDocumentAuthoringProfileV2
  | ValidatedDocumentAuthoringProfileV3;

export function resolvedArtifactOwnerIds(
  profile: ValidatedDocumentAuthoringProfileVersioned,
  artifactType: ValidatedDocumentAuthoringProfileVersioned["authoring"]["artifactTypes"][number]
): readonly string[] | undefined {
  if (profile.schemaVersion === 1) {
    return undefined;
  }
  if (profile.schemaVersion === 2) {
    const artifact = profile.authoring.artifactTypes.find(
      (candidate) => candidate.type === artifactType.type
    );
    if (artifact === undefined) {
      throw new TypeError(`Profile v2 artifact type ${artifactType.type} must declare allowedOwnerIds.`);
    }
    return Object.freeze([...artifact.allowedOwnerIds]);
  }
  const artifact = profile.authoring.artifactTypes.find(
    (candidate) => candidate.type === artifactType.type
  );
  if (artifact?.allowedOwnerIds !== undefined) {
    return Object.freeze([...artifact.allowedOwnerIds]);
  }
  const ids = artifact === undefined
    ? undefined
    : profile.authoring.ownerSets?.sets[artifact.ownerSetId];
  if (ids === undefined) {
    throw new TypeError(`Profile v3 artifact type ${artifactType.type} references an unknown ownerSetId.`);
  }
  return Object.freeze([...ids]);
}

export function resolvedProfileMetadataSidecar(
  profile: ValidatedDocumentAuthoringProfileVersioned
): ValidatedDocumentAuthoringProfileV2["catalog"]["metadataSidecar"] {
  return profile.schemaVersion === 1
    ? undefined
    : profile.catalog.metadataSidecar;
}

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

export async function loadValidatedDocumentAuthoringProfileV2(request: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly evidence: Awaited<ReturnType<typeof readDocumentAuthorityFile>>["evidence"];
  readonly profile: ValidatedDocumentAuthoringProfileVersioned;
}> {
  assertNotCancelled(request.signal);
  const file = await readDocumentAuthorityFile({
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
    assertNotCancelled(request.signal);
  } catch (error) {
    if (
      error instanceof CapabilityInputError ||
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
