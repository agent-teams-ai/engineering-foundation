import {
  validateGrantBase,
  validateGrantHistoryCustody,
  validateGrantEvidenceScope,
  validateGrantEvidenceManifest,
} from "./growth-authority-grant-evidence.js";
import type {
  GrowthAuthorityBinding,
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityReceipt,
  GrowthAuthorityRequest,
} from "../model/growth-authority.js";
import {
  growthAuthorityRequiredPhases,
  growthAuthoritySchemaVersion,
} from "../model/growth-authority.js";

import type { ChangeFingerprint } from "../ports/change-fingerprint.js";

import {
  date,
  digest,
  exact,
  invalid,
  member,
  object,
  text,
  uniqueMap,
} from "./validate-growth-authority-primitives.js";
import { validateGrowthAuthorityBinding } from "./growth-authority-request.js";
import {
  growthAuthorityRequestDigest,
  growthAuthorityGrantDigest,
  growthAuthorityCompletionDigest,
} from "./growth-authority-digests.js";
import { validateGrowthAuthorityReceipt } from "./growth-authority-receipt.js";
import {
  validateReleased,
  validateOwnerEvidence,
  type ProxyInspection,
} from "./growth-authority-released-evidence.js";
import { validatePackedEvidence } from "./growth-authority-packed-evidence.js";
import { validateGrowthMetadataRoots } from "./validate-growth-metadata-root.js";

function validateAdmissionReceipt(
  value: unknown,
  request: GrowthAuthorityRequest,
  binding: GrowthAuthorityBinding,
  fingerprint: ChangeFingerprint,
  timing: { readonly inspection?: ProxyInspection; readonly now: Date },
): GrowthAuthorityGrant["admissionReceipt"] {
  const kind = member(value, "kind");
  const row = object(value, kind === "none" ? ["kind"] : ["kind", "receipt"]);
  if (request.operation === "check") {
    if (row["kind"] !== "none") {
      invalid("growth-authority-admission-receipt-invalid");
    }
    return { kind: "none" };
  }
  if (row["kind"] !== "receipt") {
    invalid("growth-authority-admission-receipt-invalid");
  }
  const receiptValue = row["receipt"];
  const receiptKeys = [
    "schemaVersion",
    "kind",
    "receiptId",
    "grantId",
    "grantDigest",
    "requestDigest",
    "completionDigest",
    "provenance",
    "binding",
    "reportDigest",
    "coverageDigest",
    "phasesDigest",
    "verdict",
    "releaseEligible",
    "qualification",
    "operation",
    "promotion",
    "custodyRef",
    "issuedAt",
  ];
  const receiptRow = object(receiptValue, receiptKeys);
  if (
    receiptRow["schemaVersion"] !== growthAuthoritySchemaVersion ||
    receiptRow["kind"] !== "receipt" ||
    receiptRow["receiptId"] !== request.admissionReceiptId ||
    receiptRow["operation"] !== "check" ||
    receiptRow["qualification"] !== "qualified" ||
    receiptRow["verdict"] !== "admitted" ||
    receiptRow["releaseEligible"] !== true
  ) {
    invalid("growth-authority-admission-receipt-invalid");
  }
  const promotion = object(receiptRow["promotion"], ["kind"]);
  if (promotion["kind"] !== "none") {
    invalid("growth-authority-admission-receipt-invalid");
  }
  const receiptBinding = validateGrowthAuthorityBinding(receiptRow["binding"]);
  exact(receiptBinding, binding, "growth-authority-admission-binding-mismatch");
  const checkRequest: GrowthAuthorityRequest = {
    ...request,
    operation: "check",
    admissionReceiptId: null,
  };
  const requestDigest = digest(receiptRow["requestDigest"]);
  if (requestDigest !== growthAuthorityRequestDigest(checkRequest, fingerprint)) {
    invalid("growth-authority-admission-request-mismatch");
  }
  const result = {
    schemaVersion: growthAuthoritySchemaVersion,
    kind: "receipt" as const,
    receiptId: text(receiptRow["receiptId"]),
    grantId: text(receiptRow["grantId"]),
    grantDigest: digest(receiptRow["grantDigest"]),
    requestDigest,
    completionDigest: digest(receiptRow["completionDigest"]),
    binding: receiptBinding,
    reportDigest: digest(receiptRow["reportDigest"]),
    coverageDigest: digest(receiptRow["coverageDigest"]),
    phasesDigest: digest(receiptRow["phasesDigest"]),
    verdict: "admitted" as const,
    releaseEligible: true,
    qualification: "qualified" as const,
    operation: "check" as const,
    promotion: { kind: "none" as const },
    custodyRef: text(receiptRow["custodyRef"]),
    issuedAt: date(receiptRow["issuedAt"]),
  };
  if (receiptKeys.includes("provenance")) {
    return validateAdmissionProvenance(result, receiptRow, checkRequest, fingerprint, timing);
  }
  return { kind: "receipt", receipt: result };
}

function validateAdmissionProvenance(
  result: GrowthAuthorityReceipt,
  receiptRow: Record<string, unknown>,
  checkRequest: GrowthAuthorityRequest,
  fingerprint: ChangeFingerprint,
  timing: { readonly inspection?: ProxyInspection; readonly now: Date },
): GrowthAuthorityGrant["admissionReceipt"] {
  if (timing.inspection === undefined) {
    invalid("growth-authority-admission-provenance-invalid");
  }
  const provenance = object(receiptRow["provenance"], ["grant", "completion"]);
  if (Date.parse(result.issuedAt) > timing.now.getTime()) {
    invalid("growth-authority-admission-provenance-invalid");
  }
  const checkGrant = validateGrowthAuthorityGrant(
    provenance["grant"],
    checkRequest,
    fingerprint,
    timing.inspection,
    new Date(result.issuedAt),
  );
  const completionRow = object(provenance["completion"], [
    "schemaVersion",
    "kind",
    "grantId",
    "grantDigest",
    "requestDigest",
    "binding",
    "reportDigest",
    "reportByteLength",
    "coverageDigest",
    "phasesDigest",
    "verdict",
    "releaseEligible",
    "publication",
    "promotion",
  ]);
  if (
    completionRow["schemaVersion"] !== growthAuthoritySchemaVersion ||
    completionRow["kind"] !== "completion" ||
    completionRow["publication"] !== "finalized" ||
    !Number.isSafeInteger(completionRow["reportByteLength"]) ||
    (completionRow["reportByteLength"] as number) <= 0
  ) {
    invalid("growth-authority-admission-provenance-invalid");
  }
  const completion = provenance["completion"] as GrowthAuthorityCompletion;
  if (
    growthAuthorityGrantDigest(checkGrant, fingerprint) !== result.grantDigest ||
    checkGrant.grantId !== result.grantId ||
    growthAuthorityCompletionDigest(completion, fingerprint) !== result.completionDigest ||
    completion.grantId !== result.grantId ||
    completion.grantDigest !== result.grantDigest
  ) {
    invalid("growth-authority-admission-provenance-mismatch");
  }
  validateGrowthAuthorityReceipt(result, completion, "check", fingerprint);
  if (completion.coverageDigest !== checkGrant.requiredCoverageDigest) {
    invalid("growth-authority-coverage-mismatch");
  }
  return { kind: "receipt", receipt: { ...result, provenance: { grant: checkGrant, completion } } };
}

function validateGrantEnvelope(
  row: Record<string, unknown>,
  now: Date,
): { issuedAt: string; expiresAt: string } {
  const issuedAt = date(row["issuedAt"]),
    expiresAt = date(row["expiresAt"]);
  if (
    Date.parse(issuedAt) > now.getTime() ||
    Date.parse(expiresAt) <= now.getTime() ||
    Date.parse(expiresAt) <= Date.parse(issuedAt)
  ) {
    invalid("growth-authority-grant-expired");
  }
  const collections = [row["released"], row["ownerEvidence"], row["archives"], row["candidates"]];
  if (collections.some((entry) => !Array.isArray(entry) || entry.length > 10_000)) {
    invalid("growth-authority-grant-invalid");
  }
  if (!Array.isArray(row["requiredPhases"])) {
    invalid("growth-authority-phases-invalid");
  }
  exact(row["requiredPhases"], growthAuthorityRequiredPhases, "growth-authority-phases-invalid");
  return { issuedAt, expiresAt };
}

function validateGrantRow(value: unknown): Record<string, unknown> {
  const row = object(value, [
    "schemaVersion",
    "kind",
    "grantId",
    "requestDigest",
    "admissionReceipt",
    "binding",
    "workflowRef",
    "runRef",
    "issuedAt",
    "expiresAt",
    "trustedBase",
    "trustedBaseReference",
    "retainedHistory",
    "released",
    "ownerEvidence",
    "archives",
    "candidates",
    "metadataRoots",
    "requiredCoverageDigest",
    "requiredPhases",
  ]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "grant") {
    invalid("growth-authority-grant-invalid");
  }
  return row;
}

/** Validates protocol framing and exact request bindings. Content schemas are
 * validated by the verified context adapter before application policy sees it. */
export function validateGrowthAuthorityGrant(
  value: unknown,
  request: GrowthAuthorityRequest,
  fingerprint: ChangeFingerprint,
  inspection: ProxyInspection,
  now: Date,
): GrowthAuthorityGrant {
  const row = validateGrantRow(value);
  const binding = validateGrowthAuthorityBinding(row["binding"]);
  exact(binding, request.binding, "growth-authority-binding-mismatch");
  const requestDigest = digest(row["requestDigest"]);
  if (requestDigest !== growthAuthorityRequestDigest(request, fingerprint)) {
    invalid("growth-authority-request-mismatch");
  }
  const { issuedAt, expiresAt } = validateGrantEnvelope(row, now);
  const { trustedBase, trustedBaseReference, history, targetSource } = validateGrantBase(
    row,
    binding,
    fingerprint,
  );
  const releasedInput = row["released"] as unknown[],
    ownerInput = row["ownerEvidence"] as unknown[];
  const archiveInput = row["archives"] as unknown[],
    candidateInput = row["candidates"] as unknown[];
  const releasedRows = releasedInput.map((entry) =>
    validateReleased(entry, binding.invocation.repository, inspection),
  );
  const ownerRows = ownerInput.map(validateOwnerEvidence);
  const archiveRows = archiveInput.map((entry) =>
    validatePackedEvidence(entry, binding.invocation.repository, fingerprint),
  );
  const candidateRows = candidateInput.map((entry) =>
    validatePackedEvidence(entry, binding.invocation.repository, fingerprint),
  );
  const { historicalCustody, historicalEvidence } = validateGrantHistoryCustody(
    history,
    trustedBase,
    fingerprint,
  );
  const releasedByPackage = uniqueMap(
    releasedRows,
    (entry) => entry.packageName,
    "growth-authority-release-duplicate",
  );
  uniqueMap(ownerRows, (entry) => entry.decisionId, "growth-authority-owner-duplicate");
  const archiveByPackage = uniqueMap(
    archiveRows,
    (entry) => entry.packageName,
    "growth-authority-archive-duplicate",
  );
  const candidateByPackage = uniqueMap(
    candidateRows,
    (entry) => entry.packageName,
    "growth-authority-candidate-duplicate",
  );
  const released = [...releasedByPackage.values()].toSorted((left, right) =>
    left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
  );
  const ownerEvidence = ownerRows.toSorted((left, right) =>
    left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0,
  );
  const archives = [...archiveByPackage.values()].toSorted((left, right) =>
    left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
  );
  const candidates = [...candidateByPackage.values()].toSorted((left, right) =>
    left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
  );
  const metadataRoots = validateGrowthMetadataRoots(
    row["metadataRoots"],
    {
      binding,
      base: trustedBase,
      requestDigest,
      releaseScope: new Set([
        ...releasedByPackage.keys(),
        ...archiveByPackage.keys(),
        ...candidateByPackage.keys(),
      ]),
    },
    fingerprint,
  );

  validateGrantEvidenceScope(request, binding, requestDigest, {
    released,
    ownerEvidence,
    archives,
    candidates,
  });
  validateGrantEvidenceManifest(
    binding,
    { archives, candidates, metadataRoots },
    historicalCustody,
    fingerprint,
  );
  return {
    schemaVersion: growthAuthoritySchemaVersion,
    kind: "grant",
    grantId: text(row["grantId"]),
    requestDigest,
    admissionReceipt: validateAdmissionReceipt(
      row["admissionReceipt"],
      request,
      binding,
      fingerprint,
      { inspection, now },
    ),
    binding,
    workflowRef: text(row["workflowRef"]),
    runRef: text(row["runRef"]),
    issuedAt,
    expiresAt,
    trustedBase,
    trustedBaseReference,
    retainedHistory: {
      targetSource,
      targetSurfaceDigest: digest(history["targetSurfaceDigest"]),
      receiptDigest: digest(history["receiptDigest"]),
      custodyEvidenceDigest: historicalCustody,
      custodyEvidence: historicalEvidence,
    },
    released,
    ownerEvidence,
    archives,
    candidates,
    metadataRoots,
    requiredCoverageDigest: digest(row["requiredCoverageDigest"]),
    requiredPhases: growthAuthorityRequiredPhases,
  };
}
