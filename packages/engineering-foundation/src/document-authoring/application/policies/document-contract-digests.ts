import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import {
  canonicalJson,
  type CanonicalJsonValue,
  sha256Bytes,
  sha256Json
} from "../../../canonical-json.js";
import { documentTemporaryPath } from "./document-temporary-path.js";
import { documentRepositoryParentPath } from "./document-repository-path.js";

type Digest = `sha256:${string}`;
type JsonObject = Readonly<Record<string, CanonicalJsonValue>>;

const DOMAIN_PREFIX = "agent-teams.foundation.document-authoring";

class DocumentContractDigestError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentContractDigestError";
  }
}

function domainDigest(domain: string, payload: CanonicalJsonValue): Digest {
  return sha256Json({ domain, payload });
}

function withoutOwnDigest(value: JsonObject, field: string): JsonObject {
  const snapshot = JSON.parse(canonicalJson(value)) as JsonObject;
  const result: Record<string, CanonicalJsonValue> = Object.create(null) as Record<
    string,
    CanonicalJsonValue
  >;
  for (const key of Reflect.ownKeys(snapshot)) {
    if (key === field) {
      continue;
    }
    if (typeof key !== "string") {
      throw new DocumentContractDigestError(
        "Document digest input must not contain symbolic properties."
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new DocumentContractDigestError(
        "Document digest input must contain only own data properties."
      );
    }
    result[key] = descriptor.value as CanonicalJsonValue;
  }
  return result;
}

export function documentIntentDigest(intent: JsonObject): Digest {
  return domainDigest(`${DOMAIN_PREFIX}/intent/v1`, intent);
}

export function documentOwnerMembershipDigest(
  ownerCatalogDigest: string,
  ownerId: string
): Digest {
  return domainDigest(`${DOMAIN_PREFIX}/owner-membership/v1`, {
    ownerCatalogDigest,
    ownerId
  });
}

export interface DocumentIdentityDigestEntry {
  readonly id: string;
  readonly repositoryPath: string;
}

export function documentIdentityProjectionDigest(
  entries: readonly DocumentIdentityDigestEntry[]
): Digest {
  const snapshot = JSON.parse(
    canonicalJson(entries as unknown as CanonicalJsonValue)
  ) as DocumentIdentityDigestEntry[];
  const normalized = snapshot
    .map(({ id, repositoryPath }) => ({ id, repositoryPath }))
    .toSorted(
      (left, right) =>
        compareBinaryStrings(left.id, right.id) ||
        compareBinaryStrings(left.repositoryPath, right.repositoryPath)
    );
  return domainDigest(`${DOMAIN_PREFIX}/identity-projection/v1`, {
    entries: normalized
  });
}

export function documentReferencedDocumentDigest(document: {
  readonly id: string;
  readonly path: string;
}): Digest {
  const snapshot = JSON.parse(canonicalJson(document)) as {
    readonly id: string;
    readonly path: string;
  };
  return domainDigest(`${DOMAIN_PREFIX}/referenced-document/v1`, {
    id: snapshot.id,
    path: snapshot.path
  });
}

export function documentPlanDigest(plan: JsonObject): Digest {
  return domainDigest(
    `${DOMAIN_PREFIX}/plan/v1`,
    withoutOwnDigest(plan, "planDigest")
  );
}

export function documentReceiptDigest(receipt: JsonObject): Digest {
  return domainDigest(
    `${DOMAIN_PREFIX}/receipt/v1`,
    withoutOwnDigest(receipt, "receiptDigest")
  );
}

function record(value: unknown, subject: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DocumentContractDigestError(`${subject} must be a JSON object.`);
  }
  return value as JsonObject;
}

function validatedRecord(value: unknown, subject: string): JsonObject {
  const candidate = record(value, subject);
  try {
    return JSON.parse(canonicalJson(candidate)) as JsonObject;
  } catch (error) {
    throw new DocumentContractDigestError(
      `${subject} must use the closed canonical JSON data model.`,
      { cause: error }
    );
  }
}

function assertPublicationBindings(plan: JsonObject): void {
  const destination = plan["destination"];
  const expectedParent = record(
    plan["expectedParent"],
    "Document Plan expected parent"
  );
  const precondition = record(
    plan["destinationPrecondition"],
    "Document Plan destination precondition"
  );
  const capabilities = plan["requiredAdapterCapabilities"];
  let hasTemporaryCapacity = false;
  if (typeof destination === "string" && typeof plan["planDigest"] === "string") {
    try {
      documentTemporaryPath(destination, plan["planDigest"]);
      hasTemporaryCapacity = true;
    } catch {
      // The single publication error below is the stable public failure surface.
    }
  }
  if (
    typeof destination !== "string" ||
    !hasTemporaryCapacity ||
    expectedParent["path"] !== documentRepositoryParentPath(destination) ||
    expectedParent["state"] !== "directory" ||
    expectedParent["ancestry"] !== "real-directories" ||
    precondition["state"] !== "absent" ||
    !Array.isArray(capabilities) ||
    !capabilities.some((capability) => capability === "create-file-no-replace/v1")
  ) {
    throw new DocumentContractDigestError(
      "Document Plan publication bindings are invalid."
    );
  }
}

function assertIntentDigest(plan: JsonObject): void {
  const intent = record(plan["intent"], "Document Plan Intent");
  if (plan["intentDigest"] !== documentIntentDigest(intent)) {
    throw new DocumentContractDigestError("Document Plan Intent digest is invalid.");
  }
}

function assertOwnerMembershipDigest(plan: JsonObject): void {
  const intent = record(plan["intent"], "Document Plan Intent");
  const authority = record(plan["authority"], "Document Plan authority");
  const ownerCatalog = record(
    authority["ownerCatalog"],
    "Document Plan owner catalog authority"
  );
  const selectedOwner = record(plan["selectedOwner"], "Document Plan selected owner");
  if (
    typeof ownerCatalog["digest"] !== "string" ||
    typeof intent["owner"] !== "string" ||
    typeof selectedOwner["id"] !== "string" ||
    selectedOwner["id"] !== intent["owner"] ||
    selectedOwner["membershipDigest"] !==
      documentOwnerMembershipDigest(ownerCatalog["digest"], selectedOwner["id"])
  ) {
    throw new DocumentContractDigestError(
      "Document Plan owner membership digest is invalid."
    );
  }
}

function hasExactCommit(
  commit: JsonObject,
  expected: Readonly<Record<string, string>>
): boolean {
  return Object.entries(expected).every(
    ([field, value]) => commit[field] === value
  );
}

function isRecoveryCommit(outcome: string, commit: JsonObject): boolean {
  const publication = commit["publication"];
  const atomicity = commit["atomicity"];
  return (
    commit["state"] === outcome &&
    ["none", "published", "unknown"].includes(publication as string) &&
    ["not-applicable", "single-file-atomic-create"].includes(
      atomicity as string
    ) &&
    (publication !== "published" || atomicity === "single-file-atomic-create") &&
    (publication !== "none" || atomicity === "not-applicable") &&
    commit["recoverability"] === "preserved-for-recovery"
  );
}

function assertReceiptOutcomeCommit(receipt: JsonObject): void {
  const outcome = receipt["outcome"];
  const commit = record(receipt["commit"], "Document Receipt commit observation");
  const noResultOutcomes = [
    "authority-stale",
    "rejected",
    "failed-before-publication",
    "cancelled"
  ];
  const recoveryOutcomes = ["recovery-required", "manual-recovery-required"];
  const applied =
    outcome === "applied" &&
    typeof receipt["resultDigest"] === "string" &&
    hasExactCommit(commit, {
      state: "committed",
      publication: "published",
      atomicity: "single-file-atomic-create",
      recoverability: "not-required"
    });
  const alreadyApplied =
    outcome === "already-applied" &&
    typeof receipt["resultDigest"] === "string" &&
    hasExactCommit(commit, {
      state: "committed",
      publication: "preexisting-exact",
      atomicity: "not-applicable",
      recoverability: "not-required"
    });
  const noResult =
    typeof outcome === "string" &&
    noResultOutcomes.includes(outcome) &&
    receipt["resultDigest"] === undefined &&
    hasExactCommit(commit, {
      state: "not-published",
      publication: "none",
      atomicity: "not-applicable",
      recoverability: "not-required"
    });
  const recovery =
    typeof outcome === "string" &&
    recoveryOutcomes.includes(outcome) &&
    receipt["resultDigest"] === undefined &&
    isRecoveryCommit(outcome, commit);
  if (!applied && !alreadyApplied && !noResult && !recovery) {
    throw new DocumentContractDigestError(
      "Document Receipt outcome and commit observation are incompatible."
    );
  }
}

function assertReferencedDocumentDigests(plan: JsonObject): void {
  const references = plan["referencedDocuments"];
  if (!Array.isArray(references)) {
    throw new DocumentContractDigestError(
      "Document Plan referenced documents must be an array."
    );
  }
  for (const referenceValue of references as readonly CanonicalJsonValue[]) {
    const reference = record(referenceValue, "Document Plan referenced document");
    if (
      typeof reference["id"] !== "string" ||
      typeof reference["path"] !== "string" ||
      reference["projectionDigest"] !==
        documentReferencedDocumentDigest({
          id: reference["id"],
          path: reference["path"]
        })
    ) {
      throw new DocumentContractDigestError(
        "Document Plan referenced-document digest is invalid."
      );
    }
  }
}

function assertOutputDigest(plan: JsonObject): void {
  const output = record(plan["output"], "Document Plan output");
  if (typeof output["contentBase64"] !== "string") {
    throw new DocumentContractDigestError(
      "Document Plan output content must be canonical Base64."
    );
  }
  const bytes = Buffer.from(output["contentBase64"], "base64");
  if (
    bytes.toString("base64") !== output["contentBase64"] ||
    output["size"] !== bytes.byteLength ||
    output["digest"] !== sha256Bytes(bytes)
  ) {
    throw new DocumentContractDigestError("Document Plan output digest is invalid.");
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new DocumentContractDigestError(
      "Document Plan output must not start with a UTF-8 BOM."
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DocumentContractDigestError(
      "Document Plan output is not well-formed UTF-8.",
      { cause: error }
    );
  }
  if (
    source.startsWith("\uFEFF") ||
    source.includes("\u0000") ||
    source.includes("\r") ||
    !source.endsWith("\n") ||
    source.endsWith("\n\n") ||
    output["mode"] !== "0644" ||
    output["mediaType"] !== "text/markdown; charset=utf-8"
  ) {
    throw new DocumentContractDigestError(
      "Document Plan output violates the canonical Markdown byte contract."
    );
  }
}

export function assertDocumentPlanDigests(value: unknown): void {
  const plan = validatedRecord(value, "Document Plan");
  assertIntentDigest(plan);
  assertOwnerMembershipDigest(plan);
  assertReferencedDocumentDigests(plan);
  assertOutputDigest(plan);
  assertPublicationBindings(plan);
  if (plan["planDigest"] !== documentPlanDigest(plan)) {
    throw new DocumentContractDigestError("Document Plan digest is invalid.");
  }
}

export function assertDocumentReceiptDigest(
  value: unknown,
  planValue?: unknown
): void {
  const receipt = validatedRecord(value, "Document Receipt");
  if (receipt["receiptDigest"] !== documentReceiptDigest(receipt)) {
    throw new DocumentContractDigestError("Document Receipt digest is invalid.");
  }
  assertReceiptOutcomeCommit(receipt);
  if (planValue === undefined) {
    return;
  }
  assertDocumentPlanDigests(planValue);
  const plan = validatedRecord(planValue, "Document Plan");
  const output = record(plan["output"], "Document Plan output");
  const outcome = receipt["outcome"];
  const hasProvenOutput = outcome === "applied" || outcome === "already-applied";
  const supportedOutcomes = new Set([
    "applied",
    "already-applied",
    "authority-stale",
    "rejected",
    "recovery-required",
    "manual-recovery-required",
    "failed-before-publication",
    "cancelled"
  ]);
  if (
    typeof outcome !== "string" ||
    !supportedOutcomes.has(outcome) ||
    receipt["planDigest"] !== plan["planDigest"] ||
    receipt["destination"] !== plan["destination"] ||
    (hasProvenOutput && receipt["resultDigest"] !== output["digest"]) ||
    (!hasProvenOutput && receipt["resultDigest"] !== undefined)
  ) {
    throw new DocumentContractDigestError(
      "Document Receipt result evidence does not bind the referenced Plan."
    );
  }
}
