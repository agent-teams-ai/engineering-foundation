import { sha256Bytes } from "../../../canonical-json.js";
import type {
  DocumentAuthorityEvidence,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogSnapshotV2
} from "../model/document-catalog.js";
import type {
  DocumentPlanContract as DocumentPlan,
  DocumentPlanningCompilationInput
} from "../model/document-planning.js";
import {
  assertDocumentPlanDigests,
  documentIdentityProjectionDigest,
  documentIntentDigest,
  documentOwnerMembershipDigest,
  documentPlanDigest,
  documentReferencedDocumentDigest
} from "../policies/document-contract-digests.js";
import { documentRepositoryParentPath } from "../policies/document-repository-path.js";
import { projectReferencedDocuments } from "../projections/document-catalog-projections.js";
import { DocumentPlanningError } from "../../document-planning-error.js";
import {
  projectDocumentationCatalogSemanticTransitionV2
} from "../policies/document-authoring-semantic-digests.js";

const MAXIMUM_OUTPUT_BYTES = 1_048_576;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function sameEvidence(
  left: DocumentAuthorityEvidence,
  right: DocumentAuthorityEvidence
): boolean {
  return (
    left.path === right.path &&
    left.digest === right.digest &&
    left.size === right.size
  );
}

function fail(
  code: ConstructorParameters<typeof DocumentPlanningError>[0],
  message: string
): never {
  throw new DocumentPlanningError(code, message);
}

function assertCompilationAuthority(
  input: DocumentPlanningCompilationInput
): void {
  if (input.catalog.status !== "complete") {
    fail(
      "DOCUMENT_PLANNING_CATALOG_PARTIAL",
      "Document planning requires a complete rebuilt catalog."
    );
  }
  if (input.catalog.projectId !== input.profile.projectId) {
    fail(
      "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
      "Document profile and rebuilt catalog disagree on project identity."
    );
  }
  if (
    !sameEvidence(input.profile.evidence, input.catalog.authority.profile) ||
    !sameEvidence(input.metadataSchema, input.catalog.authority.metadataSchema) ||
    !sameEvidence(input.ownerCatalog, input.catalog.authority.ownerCatalog)
  ) {
    fail(
      "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
      "Document planning authority does not match the rebuilt catalog evidence."
    );
  }
  const sidecar = input.catalog.authority.metadataSidecar;
  if ((input.profile.metadataSidecar === undefined) !== (sidecar === undefined) ||
    (input.profile.metadataSidecar !== undefined && sidecar !== undefined &&
      input.profile.metadataSidecar.path !== sidecar.path)) {
    fail(
      "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
      "Document metadata sidecar does not match the rebuilt catalog evidence."
    );
  }
  if (!input.catalog.ownerIds.includes(input.intent.owner)) {
    fail(
      "DOCUMENT_PLANNING_INPUT_INVALID",
      `Document owner ${input.intent.owner} is not present in the owner catalog.`
    );
  }
}

function assertCanonicalOutput(output: string): Uint8Array {
  const bytes = new TextEncoder().encode(output);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_OUTPUT_BYTES ||
    output.startsWith("\uFEFF") ||
    output.includes("\u0000") ||
    output.includes("\r") ||
    !output.endsWith("\n") ||
    output.endsWith("\n\n")
  ) {
    fail(
      "DOCUMENT_PLANNING_OUTPUT_INVALID",
      "Rendered document violates the bounded canonical UTF-8/LF output contract."
    );
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const bits = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(bits >> 18) & 63];
    result += BASE64_ALPHABET[(bits >> 12) & 63];
    result += index + 1 < bytes.length ? BASE64_ALPHABET[(bits >> 6) & 63] : "=";
    result += index + 2 < bytes.length ? BASE64_ALPHABET[bits & 63] : "=";
  }
  return result;
}

function assertDestinationState(
  input: DocumentPlanningCompilationInput & { readonly destination: string },
  outputBytes: Uint8Array
): void {
  if (
    input.state.expectedParent.path !==
    documentRepositoryParentPath(input.destination)
  ) {
    fail(
      "DOCUMENT_PLANNING_PARENT_UNAVAILABLE",
      "Observed parent does not match the planned document destination."
    );
  }
  if (input.state.destination.state === "conflict") {
    fail(
      "DOCUMENT_PLANNING_CONFLICT",
      `Document destination is a ${input.state.destination.kind}.`
    );
  }
  if (
    input.state.destination.state === "regular-file" &&
    !equalBytes(input.state.destination.bytes, outputBytes)
  ) {
    fail(
      "DOCUMENT_PLANNING_CONFLICT",
      "Document destination already contains different bytes."
    );
  }
}

function assertSortedIdentityProjection(
  entries: readonly DocumentIdentityProjectionEntry[]
): readonly DocumentIdentityProjectionEntry[] {
  const projection = entries.map(({ id, repositoryPath }) =>
    Object.freeze({ id, repositoryPath })
  );
  const sorted = projection.toSorted(
    (left, right) =>
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) ||
      (left.repositoryPath < right.repositoryPath
        ? -1
        : left.repositoryPath > right.repositoryPath
          ? 1
          : 0)
  );
  if (
    sorted.some(
      (entry, index) =>
        entry.id !== projection[index]!.id ||
        entry.repositoryPath !== projection[index]!.repositoryPath
    )
  ) {
    fail(
      "DOCUMENT_PLANNING_OUTPUT_INVALID",
      "Document identity projection is not in canonical binary order."
    );
  }
  return Object.freeze(projection);
}

/** Pure assembly of a validated, fully observed document planning snapshot. */
export function compileDocumentPlan(
  input: DocumentPlanningCompilationInput & { readonly destination: string }
): DocumentPlan {
  assertCompilationAuthority(input);
  const outputBytes = assertCanonicalOutput(input.output);
  assertDestinationState(input, outputBytes);
  const identityProjection = assertSortedIdentityProjection(
    input.identityProjection
  );
  if (identityProjection.length > 100_000) {
    fail(
      "DOCUMENT_PLANNING_OUTPUT_INVALID",
      "Document identity projection exceeds the v1 entry budget."
    );
  }
  const references = projectReferencedDocuments(
    input.catalog,
    input.intent.related ?? []
  );
  if (references.missingIds.length > 0 || references.unresolvedIds.length > 0) {
    fail(
      "DOCUMENT_PLANNING_INPUT_INVALID",
      "Document Intent references missing or ambiguous catalog identities."
    );
  }
  const referencedDocuments = Object.freeze(
    references.documents.map((reference) =>
      Object.freeze({
        ...reference,
        projectionDigest: documentReferencedDocumentDigest(reference)
      })
    )
  );
  const output = Object.freeze({
    digest: sha256Bytes(outputBytes),
    size: outputBytes.byteLength,
    mode: "0644" as const,
    mediaType: "text/markdown; charset=utf-8" as const,
    contentBase64: encodeBase64(outputBytes)
  });
  const common = {
    compiler: input.compiler,
    projectId: input.profile.projectId,
    intent: input.intent,
    intentDigest: documentIntentDigest(
      input.intent as unknown as Readonly<
        Record<
          string,
          import("../../../canonical-json.js").CanonicalJsonValue
        >
      >
    ),
    authority: Object.freeze({
      profile: input.profile.evidence,
      metadataSchema: input.metadataSchema,
      ...(input.state.parentMaterialization === undefined ||
        input.catalog.authority.metadataSidecar === undefined
        ? {}
        : { metadataSidecar: input.catalog.authority.metadataSidecar }),
      ownerCatalog: input.ownerCatalog,
      template: input.template.evidence
    }),
    selectedOwner: Object.freeze({
      id: input.intent.owner,
      membershipDigest: documentOwnerMembershipDigest(
        input.ownerCatalog.digest,
        input.intent.owner
      )
    }),
    identityProjection: Object.freeze({
      entryCount: identityProjection.length,
      digest: documentIdentityProjectionDigest(identityProjection)
    }),
    referencedDocuments,
    destination: input.destination,
    expectedParent: input.state.expectedParent,
    destinationPrecondition: Object.freeze({ state: "absent" as const }),
    output,
    diagnostics: Object.freeze([])
  };
  const profileSemanticDigest = input.profileSemanticDigest;
  if (input.state.parentMaterialization !== undefined &&
    (profileSemanticDigest === undefined || input.catalog.semanticDigest === undefined)) {
    fail(
      "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
      "Document Plan v2 requires profile and catalog semantic digests."
    );
  }
  const catalogTransition = input.state.parentMaterialization === undefined
    ? undefined
    : projectDocumentationCatalogSemanticTransitionV2({
        catalog: input.catalog as DocumentationCatalogSnapshotV2,
        destination: input.destination,
        intent: input.intent,
        profile: input.profile
      });
  const planWithoutDigest = input.state.parentMaterialization === undefined
    ? {
        ...common,
        protocolVersion: 1 as const,
        requiredAdapterCapabilities: Object.freeze([
          "create-file-no-replace/v1"
        ] as const),
        schemaVersion: 1 as const
      }
    : {
        ...common,
        authority: Object.freeze({
          ...common.authority,
          profileSemanticDigest: profileSemanticDigest!,
          catalogPreimageSemanticDigest:
            catalogTransition!.catalogPreimageSemanticDigest,
          expectedCatalogPostimageSemanticDigest:
            catalogTransition!.expectedCatalogPostimageSemanticDigest
        }),
        parentMaterialization: input.state.parentMaterialization,
        protocolVersion: 2 as const,
        requiredAdapterCapabilities: Object.freeze([
          "create-directories-no-replace/v1",
          "create-file-no-replace/v1"
        ] as const),
        schemaVersion: 2 as const
      };
  const digestInput = planWithoutDigest;
  const plan: DocumentPlan = Object.freeze({
    ...digestInput,
    planDigest: documentPlanDigest({
      ...(digestInput as unknown as Record<string, import("../../../canonical-json.js").CanonicalJsonValue>),
      planDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    })
  });
  assertDocumentPlanDigests(plan);
  return plan;
}
