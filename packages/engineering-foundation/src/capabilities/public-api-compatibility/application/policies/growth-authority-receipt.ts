import type {
  GrowthAuthorityCompletion,
  GrowthAuthorityReceipt,
  GrowthAuthorityRequest,
} from "../model/growth-authority.js";
import { growthAuthoritySchemaVersion } from "../model/growth-authority.js";

import type { ChangeFingerprint } from "../ports/change-fingerprint.js";

import {
  date,
  digest,
  exact,
  invalid,
  member,
  object,
  text,
} from "./validate-growth-authority-primitives.js";
import { validateGrowthAuthorityBinding } from "./growth-authority-request.js";
import { growthAuthorityCompletionDigest } from "./growth-authority-digests.js";

function validatePromotion(value: unknown): GrowthAuthorityReceipt["promotion"] {
  const row = object(value, member(value, "kind") === "none" ? ["kind"] : ["kind", "planDigest"]);
  if (row["kind"] === "none") {
    return { kind: "none" };
  }
  if (row["kind"] === "plan") {
    return { kind: "plan", planDigest: digest(row["planDigest"]) };
  }
  return invalid("growth-authority-promotion-invalid");
}
export function validateGrowthAuthorityReceipt(
  value: unknown,
  completion: GrowthAuthorityCompletion,
  operation: GrowthAuthorityRequest["operation"],
  fingerprint: ChangeFingerprint,
): GrowthAuthorityReceipt {
  const row = object(value, [
    "schemaVersion",
    "kind",
    "receiptId",
    "grantId",
    "grantDigest",
    "requestDigest",
    "completionDigest",
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
  ]);
  if (
    row["schemaVersion"] !== growthAuthoritySchemaVersion ||
    row["kind"] !== "receipt" ||
    row["operation"] !== operation
  ) {
    invalid("growth-authority-receipt-invalid");
  }
  const binding = validateGrowthAuthorityBinding(row["binding"]),
    promotion = validatePromotion(row["promotion"]);
  exact(binding, completion.binding, "growth-authority-receipt-binding-mismatch");
  if ((operation === "check") !== (promotion.kind === "none")) {
    invalid("growth-authority-promotion-invalid");
  }
  const verdict = row["verdict"],
    releaseEligible = row["releaseEligible"],
    qualification = row["qualification"];
  if (
    (verdict !== "admitted" && verdict !== "rejected" && verdict !== "incomplete") ||
    typeof releaseEligible !== "boolean" ||
    (qualification !== "qualified" && qualification !== "not-qualified")
  ) {
    invalid("growth-authority-receipt-invalid");
  }
  const receipt: GrowthAuthorityReceipt = {
    schemaVersion: growthAuthoritySchemaVersion,
    kind: "receipt",
    receiptId: text(row["receiptId"]),
    grantId: text(row["grantId"]),
    grantDigest: digest(row["grantDigest"]),
    requestDigest: digest(row["requestDigest"]),
    completionDigest: digest(row["completionDigest"]),
    binding,
    reportDigest: digest(row["reportDigest"]),
    coverageDigest: digest(row["coverageDigest"]),
    phasesDigest: digest(row["phasesDigest"]),
    verdict,
    releaseEligible,
    qualification,
    operation,
    promotion,
    custodyRef: text(row["custodyRef"]),
    issuedAt: date(row["issuedAt"]),
  };
  exact(
    {
      grantId: receipt.grantId,
      grantDigest: receipt.grantDigest,
      requestDigest: receipt.requestDigest,
      binding: receipt.binding,
      reportDigest: receipt.reportDigest,
      coverageDigest: receipt.coverageDigest,
      phasesDigest: receipt.phasesDigest,
      verdict: receipt.verdict,
      releaseEligible: receipt.releaseEligible,
      promotion: receipt.promotion,
    },
    {
      grantId: completion.grantId,
      grantDigest: completion.grantDigest,
      requestDigest: completion.requestDigest,
      binding: completion.binding,
      reportDigest: completion.reportDigest,
      coverageDigest: completion.coverageDigest,
      phasesDigest: completion.phasesDigest,
      verdict: completion.verdict,
      releaseEligible: completion.releaseEligible,
      promotion: completion.promotion,
    },
    "growth-authority-receipt-mismatch",
  );
  if (receipt.completionDigest !== growthAuthorityCompletionDigest(completion, fingerprint)) {
    invalid("growth-authority-completion-mismatch");
  }
  if (
    (receipt.qualification === "qualified") !==
    (receipt.verdict === "admitted" && receipt.releaseEligible)
  ) {
    invalid("growth-authority-qualification-mismatch");
  }
  return receipt;
}
