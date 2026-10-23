import { input, optionsRecord, copyBytes } from "./growth-authority-tooling-input.js";
import { createHash } from "node:crypto";
import { types } from "node:util";

import type {
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityReceipt,
  GrowthAuthorityRequest,
} from "../../../application/model/growth-authority.js";
import { growthAuthoritySchemaVersion } from "../../../application/model/growth-authority.js";
import { GrowthObservationInvariantError } from "../../../application/model/growth-observation.js";
import type { GrowthDigest } from "../../../application/model/growth-observation.js";
import type { GrowthReport } from "../../../application/model/growth-report.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";
import { NodeChangeFingerprint } from "../../outbound/crypto/node-change-fingerprint.js";
import { parseStrictJsonResponse } from "../../outbound/reviewrouter/strict-json-response.js";
import {
  growthCanonicalJson,
  growthObservationReference,
} from "../../../application/policies/normalize-growth-observation.js";
import { validateGrowthReport } from "../../../application/policies/validate-growth-report.js";
import {
  growthAuthorityCompletionDigest,
  growthAuthorityGrantDigest,
  growthAuthorityRequestDigest,
  growthReportAuthorityDigests,
  validateGrowthAuthorityBinding,
  validateGrowthAuthorityGrant,
  digest,
  exact,
  invalid,
  object,
  text,
  validateGrowthAuthorityReceipt,
  validateGrowthAuthorityRequest,
} from "../../../application/policies/validate-growth-authority.js";

const fingerprint = new NodeChangeFingerprint();
const inspection = Object.freeze({ isProxy: types.isProxy });

export interface GrowthToolingValidated<T> {
  readonly value: T;
  readonly wire: string;
  readonly wireDigest: GrowthDigest;
  readonly protocolDigest: GrowthDigest;
}
export type GrowthToolingValidatedReceipt = Omit<
  GrowthToolingValidated<GrowthAuthorityReceipt>,
  "protocolDigest"
>;

function wire<T>(value: T): { value: T; wire: string; wireDigest: GrowthDigest } {
  const serialized = growthCanonicalJson(value);
  return {
    value,
    wire: serialized,
    wireDigest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}

function request(value: unknown): GrowthAuthorityRequest {
  return validateGrowthAuthorityRequest(input(value));
}

export function decodeRequest(value: unknown): GrowthToolingValidated<GrowthAuthorityRequest> {
  const validated = request(value);
  return {
    ...wire(validated),
    protocolDigest: growthAuthorityRequestDigest(validated, fingerprint),
  };
}

function grant(
  value: unknown,
  validatedRequest: GrowthAuthorityRequest,
  now: Date,
): GrowthAuthorityGrant {
  return validateGrowthAuthorityGrant(input(value), validatedRequest, fingerprint, inspection, now);
}
function historicalGrant(
  value: unknown,
  validatedRequest: GrowthAuthorityRequest,
): GrowthAuthorityGrant {
  const safe = input(value);
  return validateGrowthAuthorityGrant(
    safe,
    validatedRequest,
    fingerprint,
    inspection,
    historicalTime(safe),
  );
}
function issuanceTime(value: unknown): Date {
  if (types.isProxy(value) || value === null || typeof value !== "object") {
    invalid("growth-authority-trusted-time-invalid");
  }
  let milliseconds: number;
  try {
    milliseconds = Date.prototype.getTime.call(value);
  } catch {
    invalid("growth-authority-trusted-time-invalid");
  }
  if (Object.getPrototypeOf(value) !== Date.prototype) {
    invalid("growth-authority-trusted-time-invalid");
  }
  if (!Number.isFinite(milliseconds)) {
    invalid("growth-authority-trusted-time-invalid");
  }
  return new Date(milliseconds);
}
function historicalTime(value: unknown): Date {
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
  // Historical decoding tests the closed grant during its own validity window.
  // A promotion admission receipt can be issued after the promotion grant's
  // issuedAt, so the lower bound is not a valid historical observation time.
  const expires = new Date(text(row["expiresAt"]));
  if (!Number.isFinite(expires.getTime())) {
    invalid("growth-authority-time-invalid");
  }
  return new Date(expires.getTime() - 1);
}
export function encodeGrant(
  value: unknown,
  options: { readonly request: unknown; readonly now: Date },
): GrowthToolingValidated<GrowthAuthorityGrant> {
  const args = optionsRecord(options, ["request", "now"]);
  const validatedRequest = request(args["request"]);
  const validated = grant(value, validatedRequest, issuanceTime(args["now"]));
  return { ...wire(validated), protocolDigest: growthAuthorityGrantDigest(validated, fingerprint) };
}

function reportBytes(value: unknown): Uint8Array {
  return copyBytes(value);
}
/** Pure parser for the exact retained report artifact, including its final LF. */
function parseFinalizedGrowthReportBytes(
  bytes: Uint8Array,
  reportFingerprint: ChangeFingerprint,
): GrowthReport {
  const safe = reportBytes(bytes);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(safe);
  } catch {
    throw new GrowthObservationInvariantError("growth-authority-report-json-invalid");
  }
  const report = validateGrowthReport(
    parseStrictJsonResponse(source, 64) as GrowthReport,
    reportFingerprint,
  );
  if (!Buffer.from(safe).equals(Buffer.from(`${growthCanonicalJson(report)}\n`, "utf8"))) {
    throw new GrowthObservationInvariantError("growth-authority-report-bytes-invalid");
  }
  return report;
}
function assertReportBinding(
  report: GrowthReport,
  requestValue: GrowthAuthorityRequest,
  current: GrowthAuthorityGrant,
  bytes: Uint8Array,
): void {
  const authorityGrant =
    requestValue.operation === "check"
      ? current
      : current.admissionReceipt.kind === "receipt"
        ? current.admissionReceipt.receipt.provenance?.grant
        : undefined;
  if (
    requestValue.operation === "promote-release" &&
    current.admissionReceipt.kind === "receipt" &&
    authorityGrant !== undefined
  ) {
    const priorCompletion = current.admissionReceipt.receipt.provenance?.completion;
    if (priorCompletion === undefined) {
      invalid("growth-authority-admission-provenance-invalid");
    }
    const priorRow = object(priorCompletion, [
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
    assertCompletionFields(priorRow, authorityGrant, report, bytes, authorityGrant.requestDigest);
  }
  if (
    authorityGrant === undefined ||
    report.authority.status !== "verified" ||
    report.authority.receiptDigest !== growthAuthorityGrantDigest(authorityGrant, fingerprint) ||
    report.authority.workflowRef !== authorityGrant.workflowRef ||
    report.authority.runRef !== authorityGrant.runRef
  ) {
    invalid("growth-authority-completion-report-authority-mismatch");
  }
  assertReportSources(report, authorityGrant);
  const coverageDigest = growthReportAuthorityDigests(report, fingerprint).coverageDigest;
  if (
    coverageDigest !== authorityGrant.requiredCoverageDigest ||
    coverageDigest !== current.requiredCoverageDigest
  ) {
    invalid("growth-authority-coverage-mismatch");
  }
}
function assertReportSources(report: GrowthReport, authorityGrant: GrowthAuthorityGrant): void {
  const invocation = authorityGrant.binding.invocation;
  exact(report.repository, invocation.repository, "growth-authority-report-source-mismatch");
  exact(report.tool, invocation.tool, "growth-authority-report-source-mismatch");
  if (report.trustedBase.status === "available") {
    exact(
      report.trustedBase.value,
      authorityGrant.trustedBaseReference,
      "growth-authority-report-source-mismatch",
    );
  }
  if (report.candidate.status === "available") {
    const candidate = report.candidate.value;
    exact(
      {
        sourceCommit: candidate.sourceCommit,
        sourceTree: candidate.sourceTree,
        topologyDigest: candidate.topologyDigest,
        lockDigest: candidate.lockDigest,
        toolchainDigest: candidate.toolchainDigest,
        artifactDigests: candidate.artifactDigests,
      },
      {
        sourceCommit: invocation.sourceCommit,
        sourceTree: invocation.sourceTree,
        topologyDigest: invocation.topologyDigest,
        lockDigest: invocation.lockDigest,
        toolchainDigest: invocation.toolchainDigest,
        artifactDigests: invocation.artifactDigests,
      },
      "growth-authority-report-source-mismatch",
    );
  }
  if (report.trustedBaseComparison.status === "complete") {
    if (report.trustedBase.status !== "available" || report.candidate.status !== "available") {
      invalid("growth-authority-report-source-mismatch");
    }
    exact(
      { before: report.trustedBaseComparison.before, after: report.trustedBaseComparison.after },
      {
        before: report.trustedBase.value.surfaceDigest,
        after: report.candidate.value.surfaceDigest,
      },
      "growth-authority-report-source-mismatch",
    );
  }
  if (report.verdict === "admitted") {
    exact(
      report.transitionReceipts[0]?.decisions,
      authorityGrant.ownerEvidence.map((entry) => entry.decisionDigest).toSorted(),
      "growth-authority-report-source-mismatch",
    );
  }
  exact(
    report.released.map((row) => ({ packageName: row.packageName, kind: row.evidence.kind })),
    authorityGrant.released.map((row) => ({
      packageName: row.packageName,
      kind: row.evidence.kind,
    })),
    "growth-authority-report-source-mismatch",
  );
  for (const row of report.released) {
    const retained = authorityGrant.released.find((entry) => entry.packageName === row.packageName);
    if (
      retained?.evidence.kind === "released" &&
      row.evidence.kind === "released" &&
      row.evidence.observation.status === "available"
    ) {
      const archive = authorityGrant.archives.find(
        (entry) => entry.packageName === row.packageName,
      );
      if (archive === undefined) {
        invalid("growth-authority-report-source-mismatch");
      }
      exact(
        row.evidence.observation.value,
        growthObservationReference(archive.observation, fingerprint),
        "growth-authority-report-source-mismatch",
      );
    }
    if (
      retained?.evidence.kind === "initial-unreleased" &&
      row.evidence.kind === "initial-unreleased" &&
      row.evidence.history.status === "available"
    ) {
      exact(
        row.evidence.history.value,
        retained.evidence.historyDigest,
        "growth-authority-report-source-mismatch",
      );
    }
  }
}
function assertCompletionFields(
  row: Record<string, unknown>,
  grantValue: GrowthAuthorityGrant,
  report: GrowthReport,
  bytes: Uint8Array,
  requestDigest: GrowthDigest,
): void {
  const reportDigests = growthReportAuthorityDigests(report, fingerprint);
  const reportDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (
    row["grantId"] !== grantValue.grantId ||
    row["grantDigest"] !== growthAuthorityGrantDigest(grantValue, fingerprint) ||
    row["requestDigest"] !== requestDigest ||
    row["reportDigest"] !== reportDigest ||
    row["reportByteLength"] !== bytes.byteLength ||
    row["coverageDigest"] !== reportDigests.coverageDigest ||
    row["phasesDigest"] !== reportDigests.phasesDigest ||
    row["verdict"] !== report.verdict ||
    row["releaseEligible"] !== report.releaseEligible
  ) {
    invalid("growth-authority-completion-mismatch");
  }
}
function validateCompletion(
  value: unknown,
  options: {
    readonly request: unknown;
    readonly grant: unknown;
    readonly finalizedReportBytes: unknown;
  },
  validatedContext?: {
    readonly request: GrowthAuthorityRequest;
    readonly grant: GrowthAuthorityGrant;
  },
): GrowthAuthorityCompletion {
  const args = optionsRecord(options, ["request", "grant", "finalizedReportBytes"]);
  const validatedRequest = validatedContext?.request ?? request(args["request"]);
  const validatedGrant =
    validatedContext?.grant ?? historicalGrant(args["grant"], validatedRequest);
  const row = object(input(value), [
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
    row["schemaVersion"] !== growthAuthoritySchemaVersion ||
    row["kind"] !== "completion" ||
    row["publication"] !== "finalized"
  ) {
    invalid("growth-authority-completion-invalid");
  }
  const binding = validateGrowthAuthorityBinding(row["binding"]);
  exact(binding, validatedRequest.binding, "growth-authority-completion-binding-mismatch");
  const bytes = reportBytes(args["finalizedReportBytes"]);
  const report = parseFinalizedGrowthReportBytes(bytes, fingerprint);
  assertReportBinding(report, validatedRequest, validatedGrant, bytes);
  const reportDigests = growthReportAuthorityDigests(report, fingerprint);
  const promotion = object(
    row["promotion"],
    validatedRequest.operation === "check" ? ["kind"] : ["kind", "planDigest"],
  );
  if (
    (validatedRequest.operation === "check" && promotion["kind"] !== "none") ||
    (validatedRequest.operation === "promote-release" && promotion["kind"] !== "plan")
  ) {
    invalid("growth-authority-promotion-invalid");
  }
  const normalizedPromotion =
    promotion["kind"] === "none"
      ? { kind: "none" as const }
      : { kind: "plan" as const, planDigest: digest(promotion["planDigest"]) };
  assertCompletionFields(
    row,
    validatedGrant,
    report,
    bytes,
    growthAuthorityRequestDigest(validatedRequest, fingerprint),
  );
  return {
    schemaVersion: growthAuthoritySchemaVersion,
    kind: "completion",
    grantId: validatedGrant.grantId,
    grantDigest: digest(row["grantDigest"]),
    requestDigest: digest(row["requestDigest"]),
    binding,
    reportDigest: digest(row["reportDigest"]),
    reportByteLength: bytes.byteLength,
    coverageDigest: reportDigests.coverageDigest,
    phasesDigest: reportDigests.phasesDigest,
    verdict: report.verdict,
    releaseEligible: report.releaseEligible,
    publication: "finalized",
    promotion: normalizedPromotion,
  };
}
export function decodeCompletion(
  value: unknown,
  options: {
    readonly request: unknown;
    readonly grant: unknown;
    readonly finalizedReportBytes: unknown;
  },
): GrowthToolingValidated<GrowthAuthorityCompletion> {
  const validated = validateCompletion(value, options);
  return {
    ...wire(validated),
    protocolDigest: growthAuthorityCompletionDigest(validated, fingerprint),
  };
}
export function encodeReceipt(
  value: unknown,
  options: {
    readonly request: unknown;
    readonly grant: unknown;
    readonly completion: unknown;
    readonly finalizedReportBytes: unknown;
  },
): GrowthToolingValidatedReceipt {
  const args = optionsRecord(options, ["request", "grant", "completion", "finalizedReportBytes"]);
  const validatedRequest = request(args["request"]);
  const validatedGrant = historicalGrant(args["grant"], validatedRequest);
  const validatedCompletion = validateCompletion(
    args["completion"],
    {
      request: validatedRequest,
      grant: validatedGrant,
      finalizedReportBytes: args["finalizedReportBytes"],
    },
    { request: validatedRequest, grant: validatedGrant },
  );
  const validated = validateGrowthAuthorityReceipt(
    input(value),
    validatedCompletion,
    validatedRequest.operation,
    fingerprint,
  );
  if (
    validated.grantId !== validatedGrant.grantId ||
    validated.grantDigest !== growthAuthorityGrantDigest(validatedGrant, fingerprint) ||
    validated.requestDigest !== growthAuthorityRequestDigest(validatedRequest, fingerprint)
  ) {
    invalid("growth-authority-receipt-grant-mismatch");
  }
  return wire(validated);
}
