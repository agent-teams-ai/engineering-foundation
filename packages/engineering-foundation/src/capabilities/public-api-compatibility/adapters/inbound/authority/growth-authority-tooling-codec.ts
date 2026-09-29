import { createHash } from "node:crypto";
import { types } from "node:util";

import type { GrowthAuthorityCompletion, GrowthAuthorityGrant, GrowthAuthorityReceipt, GrowthAuthorityRequest } from "../../../application/model/growth-authority.js";
import { growthAuthoritySchemaVersion } from "../../../application/model/growth-authority.js";
import { GrowthObservationInvariantError } from "../../../application/model/growth-observation.js";
import type { GrowthDigest } from "../../../application/model/growth-observation.js";
import type { GrowthReport } from "../../../application/model/growth-report.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";
import { NodeChangeFingerprint } from "../../outbound/crypto/node-change-fingerprint.js";
import { parseStrictJsonResponse } from "../../outbound/reviewrouter/strict-json-response.js";
import { growthCanonicalJson, growthObservationReference } from "../../../application/policies/normalize-growth-observation.js";
import { validateGrowthReport } from "../../../application/policies/validate-growth-report.js";
import { growthAuthorityCompletionDigest, growthAuthorityGrantDigest, growthAuthorityRequestDigest,
  growthReportAuthorityDigests, validateGrowthAuthorityBinding, validateGrowthAuthorityGrant, digest, exact, invalid, object, text,
  validateGrowthAuthorityReceipt, validateGrowthAuthorityRequest } from "../../../application/policies/validate-growth-authority.js";

const fingerprint = new NodeChangeFingerprint();
const inspection = Object.freeze({ isProxy: types.isProxy });
const maximumBytes = 32 * 1024 * 1024;
const encoder = new TextEncoder();

export interface GrowthToolingValidated<T> {
  readonly value: T;
  readonly wire: string;
  readonly wireDigest: GrowthDigest;
  readonly protocolDigest: GrowthDigest;
}
export type GrowthToolingValidatedReceipt = Omit<GrowthToolingValidated<GrowthAuthorityReceipt>, "protocolDigest">;

/** A descriptor-only snapshot. No producer getter, proxy trap or custom method is invoked. */
function snapshot(value: unknown, budget: { nodes: number; units: number }, depth = 0): unknown {
  if (++budget.nodes > 1_000_000 || depth > 64 || types.isProxy(value)) { invalid("growth-authority-tooling-input-unsafe"); }
  if (typeof value === "string") {
    budget.units += value.length;
    if (budget.units > maximumBytes) { invalid("growth-authority-tooling-input-budget-exhausted"); }
  }
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) { return value; }
  if (typeof value !== "object") { invalid("growth-authority-tooling-input-unsafe"); }
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) { invalid("growth-authority-tooling-input-unsafe"); }
  return isArray ? snapshotArray(value, budget, depth) : snapshotObject(value, budget, depth);
}
function snapshotArray(value: object, budget: { nodes: number; units: number }, depth: number): unknown[] {
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || keys.length !== (length as number) + 1) { invalid("growth-authority-tooling-input-unsafe"); }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) { invalid("growth-authority-tooling-input-unsafe"); }
    result.push(snapshot(descriptor.value, budget, depth + 1));
  }
  return result;
}
function snapshotObject(value: object, budget: { nodes: number; units: number }, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key.normalize("NFC") !== key) { invalid("growth-authority-tooling-input-unsafe"); }
    budget.units += key.length;
    if (budget.units > maximumBytes) { invalid("growth-authority-tooling-input-budget-exhausted"); }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) { invalid("growth-authority-tooling-input-unsafe"); }
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, budget, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function input(value: unknown): unknown {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > maximumBytes || encoder.encode(value).byteLength > maximumBytes) { invalid("growth-authority-tooling-input-budget-exhausted"); }
    parsed = parseStrictJsonResponse(value, 64);
  } else if (intrinsicByteLength(value) !== null) {
    const bytes = copyBytes(value);
    parsed = parseStrictJsonResponse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), 64);
  }
  const safe = snapshot(parsed, { nodes: 0, units: 0 });
  if (encoder.encode(growthCanonicalJson(safe)).byteLength > maximumBytes) { invalid("growth-authority-tooling-input-budget-exhausted"); }
  return safe;
}
function optionsRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) { invalid("growth-authority-tooling-options-unsafe"); }
  return object(value, keys, "growth-authority-tooling-options-unsafe");
}

function wire<T>(value: T): { value: T; wire: string; wireDigest: GrowthDigest } {
  const serialized = growthCanonicalJson(value);
  return { value, wire: serialized, wireDigest: `sha256:${createHash("sha256").update(serialized).digest("hex")}` };
}

function request(value: unknown): GrowthAuthorityRequest {
  return validateGrowthAuthorityRequest(input(value));
}

export function decodeRequest(value: unknown): GrowthToolingValidated<GrowthAuthorityRequest> {
  const validated = request(value);
  return { ...wire(validated), protocolDigest: growthAuthorityRequestDigest(validated, fingerprint) };
}

function grant(value: unknown, validatedRequest: GrowthAuthorityRequest, now: Date): GrowthAuthorityGrant {
  return validateGrowthAuthorityGrant(input(value), validatedRequest, fingerprint, inspection, now);
}
function historicalGrant(value: unknown, validatedRequest: GrowthAuthorityRequest): GrowthAuthorityGrant {
  const safe = input(value);
  return validateGrowthAuthorityGrant(safe, validatedRequest, fingerprint, inspection, historicalTime(safe));
}
function issuanceTime(value: unknown): Date {
  if (types.isProxy(value) || value === null || typeof value !== "object") { invalid("growth-authority-trusted-time-invalid"); }
  let milliseconds: number;
  try { milliseconds = Date.prototype.getTime.call(value); }
  catch { invalid("growth-authority-trusted-time-invalid"); }
  if (Object.getPrototypeOf(value) !== Date.prototype) { invalid("growth-authority-trusted-time-invalid"); }
  if (!Number.isFinite(milliseconds)) { invalid("growth-authority-trusted-time-invalid"); }
  return new Date(milliseconds);
}
function historicalTime(value: unknown): Date {
  const row = object(value, ["schemaVersion", "kind", "grantId", "requestDigest", "admissionReceipt", "binding", "workflowRef", "runRef", "issuedAt", "expiresAt",
    "trustedBase", "trustedBaseReference", "retainedHistory", "released", "ownerEvidence", "archives", "candidates", "metadataRoots", "requiredCoverageDigest", "requiredPhases"]);
  // Historical decoding tests the closed grant during its own validity window.
  // A promotion admission receipt can be issued after the promotion grant's
  // issuedAt, so the lower bound is not a valid historical observation time.
  const expires = new Date(text(row["expiresAt"]));
  if (!Number.isFinite(expires.getTime())) { invalid("growth-authority-time-invalid"); }
  return new Date(expires.getTime() - 1);
}
export function encodeGrant(value: unknown, options: { readonly request: unknown; readonly now: Date }): GrowthToolingValidated<GrowthAuthorityGrant> {
  const args = optionsRecord(options, ["request", "now"]);
  const validatedRequest = request(args["request"]);
  const validated = grant(value, validatedRequest, issuanceTime(args["now"]));
  return { ...wire(validated), protocolDigest: growthAuthorityGrantDigest(validated, fingerprint) };
}

function intrinsicByteLength(value: unknown): number | null {
  if (types.isProxy(value) || value === null || typeof value !== "object") { return null; }
  try {
    const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get?.call(value) as unknown;
    return typeof length === "number" ? length : null;
  } catch { return null; }
}
function copyBytes(value: unknown): Uint8Array {
  const length = intrinsicByteLength(value);
  if (length === null) { invalid("growth-authority-tooling-input-unsafe"); }
  const source = value as Uint8Array; // Intrinsic typed-array brand was checked above.
  const prototype: unknown = Object.getPrototypeOf(source);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) { invalid("growth-authority-tooling-input-unsafe"); }
  if (["byteLength", "byteOffset", "buffer", "length"].some((key) => Object.hasOwn(source, key))
    || Object.hasOwn(source, Symbol.iterator)) { invalid("growth-authority-tooling-input-unsafe"); }
  if (typeof length !== "number" || length === 0 || length > maximumBytes) { invalid("growth-authority-tooling-input-budget-exhausted"); }
  return Uint8Array.from(Uint8Array.prototype.values.call(source));
}
function reportBytes(value: unknown): Uint8Array {
  return copyBytes(value);
}
/** Pure parser for the exact retained report artifact, including its final LF. */
export function parseFinalizedGrowthReportBytes(bytes: Uint8Array, reportFingerprint: ChangeFingerprint = fingerprint): GrowthReport {
  const safe = reportBytes(bytes);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(safe); }
  catch { throw new GrowthObservationInvariantError("growth-authority-report-json-invalid"); }
  const report = validateGrowthReport(parseStrictJsonResponse(source, 64) as GrowthReport, reportFingerprint);
  if (!Buffer.from(safe).equals(Buffer.from(`${growthCanonicalJson(report)}\n`, "utf8"))) {
    throw new GrowthObservationInvariantError("growth-authority-report-bytes-invalid");
  }
  return report;
}
function assertReportBinding(report: GrowthReport, requestValue: GrowthAuthorityRequest, current: GrowthAuthorityGrant, bytes: Uint8Array): void {
  const authorityGrant = requestValue.operation === "check" ? current
    : current.admissionReceipt.kind === "receipt" ? current.admissionReceipt.receipt.provenance?.grant : undefined;
  if (requestValue.operation === "promote-release" && current.admissionReceipt.kind === "receipt" && authorityGrant !== undefined) {
    const priorCompletion = current.admissionReceipt.receipt.provenance?.completion;
    if (priorCompletion === undefined) { invalid("growth-authority-admission-provenance-invalid"); }
    const priorRow = object(priorCompletion, ["schemaVersion", "kind", "grantId", "grantDigest", "requestDigest", "binding", "reportDigest", "reportByteLength",
      "coverageDigest", "phasesDigest", "verdict", "releaseEligible", "publication", "promotion"]);
    assertCompletionFields(priorRow, authorityGrant, report, bytes, authorityGrant.requestDigest);
  }
  if (authorityGrant === undefined || report.authority.status !== "verified"
    || report.authority.receiptDigest !== growthAuthorityGrantDigest(authorityGrant, fingerprint)
    || report.authority.workflowRef !== authorityGrant.workflowRef || report.authority.runRef !== authorityGrant.runRef) {
    invalid("growth-authority-completion-report-authority-mismatch");
  }
  assertReportSources(report, authorityGrant);
  const coverageDigest = growthReportAuthorityDigests(report, fingerprint).coverageDigest;
  if (coverageDigest !== authorityGrant.requiredCoverageDigest || coverageDigest !== current.requiredCoverageDigest) {
    invalid("growth-authority-coverage-mismatch");
  }
}
function assertReportSources(report: GrowthReport, authorityGrant: GrowthAuthorityGrant): void {
  const invocation = authorityGrant.binding.invocation;
  exact(report.repository, invocation.repository, "growth-authority-report-source-mismatch");
  exact(report.tool, invocation.tool, "growth-authority-report-source-mismatch");
  if (report.trustedBase.status === "available") {
    exact(report.trustedBase.value, authorityGrant.trustedBaseReference, "growth-authority-report-source-mismatch");
  }
  if (report.candidate.status === "available") {
    const candidate = report.candidate.value;
    exact({ sourceCommit: candidate.sourceCommit, sourceTree: candidate.sourceTree, topologyDigest: candidate.topologyDigest,
      lockDigest: candidate.lockDigest, toolchainDigest: candidate.toolchainDigest, artifactDigests: candidate.artifactDigests },
    { sourceCommit: invocation.sourceCommit, sourceTree: invocation.sourceTree, topologyDigest: invocation.topologyDigest,
      lockDigest: invocation.lockDigest, toolchainDigest: invocation.toolchainDigest, artifactDigests: invocation.artifactDigests },
    "growth-authority-report-source-mismatch");
  }
  if (report.trustedBaseComparison.status === "complete") {
    if (report.trustedBase.status !== "available" || report.candidate.status !== "available") { invalid("growth-authority-report-source-mismatch"); }
    exact({ before: report.trustedBaseComparison.before, after: report.trustedBaseComparison.after },
      { before: report.trustedBase.value.surfaceDigest, after: report.candidate.value.surfaceDigest }, "growth-authority-report-source-mismatch");
  }
  if (report.verdict === "admitted") {
    exact(report.transitionReceipts[0]?.decisions, authorityGrant.ownerEvidence.map((entry) => entry.decisionDigest).toSorted(),
      "growth-authority-report-source-mismatch");
  }
  exact(report.released.map((row) => ({ packageName: row.packageName, kind: row.evidence.kind })),
    authorityGrant.released.map((row) => ({ packageName: row.packageName, kind: row.evidence.kind })), "growth-authority-report-source-mismatch");
  for (const row of report.released) {
    const retained = authorityGrant.released.find((entry) => entry.packageName === row.packageName);
    if (retained?.evidence.kind === "released" && row.evidence.kind === "released" && row.evidence.observation.status === "available") {
      const archive = authorityGrant.archives.find((entry) => entry.packageName === row.packageName);
      if (archive === undefined) { invalid("growth-authority-report-source-mismatch"); }
      exact(row.evidence.observation.value, growthObservationReference(archive.observation, fingerprint), "growth-authority-report-source-mismatch");
    }
    if (retained?.evidence.kind === "initial-unreleased" && row.evidence.kind === "initial-unreleased" && row.evidence.history.status === "available") {
      exact(row.evidence.history.value, retained.evidence.historyDigest, "growth-authority-report-source-mismatch");
    }
  }
}
function assertCompletionFields(row: Record<string, unknown>, grantValue: GrowthAuthorityGrant,
  report: GrowthReport, bytes: Uint8Array, requestDigest: GrowthDigest): void {
  const reportDigests = growthReportAuthorityDigests(report, fingerprint);
  const reportDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (row["grantId"] !== grantValue.grantId || row["grantDigest"] !== growthAuthorityGrantDigest(grantValue, fingerprint)
    || row["requestDigest"] !== requestDigest
    || row["reportDigest"] !== reportDigest || row["reportByteLength"] !== bytes.byteLength
    || row["coverageDigest"] !== reportDigests.coverageDigest || row["phasesDigest"] !== reportDigests.phasesDigest
    || row["verdict"] !== report.verdict || row["releaseEligible"] !== report.releaseEligible) { invalid("growth-authority-completion-mismatch"); }
}
function validateCompletion(value: unknown, options: { readonly request: unknown; readonly grant: unknown; readonly finalizedReportBytes: unknown },
  validatedContext?: { readonly request: GrowthAuthorityRequest; readonly grant: GrowthAuthorityGrant }): GrowthAuthorityCompletion {
  const args = optionsRecord(options, ["request", "grant", "finalizedReportBytes"]);
  const validatedRequest = validatedContext?.request ?? request(args["request"]);
  const validatedGrant = validatedContext?.grant ?? historicalGrant(args["grant"], validatedRequest);
  const row = object(input(value), ["schemaVersion", "kind", "grantId", "grantDigest", "requestDigest", "binding", "reportDigest", "reportByteLength",
    "coverageDigest", "phasesDigest", "verdict", "releaseEligible", "publication", "promotion"]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "completion" || row["publication"] !== "finalized") {
    invalid("growth-authority-completion-invalid");
  }
  const binding = validateGrowthAuthorityBinding(row["binding"]);
  exact(binding, validatedRequest.binding, "growth-authority-completion-binding-mismatch");
  const bytes = reportBytes(args["finalizedReportBytes"]);
  const report = parseFinalizedGrowthReportBytes(bytes, fingerprint);
  assertReportBinding(report, validatedRequest, validatedGrant, bytes);
  const reportDigests = growthReportAuthorityDigests(report, fingerprint);
  const promotion = object(row["promotion"], validatedRequest.operation === "check" ? ["kind"] : ["kind", "planDigest"]);
  if ((validatedRequest.operation === "check" && promotion["kind"] !== "none")
    || (validatedRequest.operation === "promote-release" && promotion["kind"] !== "plan")) { invalid("growth-authority-promotion-invalid"); }
  const normalizedPromotion = promotion["kind"] === "none" ? { kind: "none" as const } : { kind: "plan" as const, planDigest: digest(promotion["planDigest"]) };
  assertCompletionFields(row, validatedGrant, report, bytes, growthAuthorityRequestDigest(validatedRequest, fingerprint));
  return { schemaVersion: growthAuthoritySchemaVersion, kind: "completion", grantId: validatedGrant.grantId,
    grantDigest: digest(row["grantDigest"]), requestDigest: digest(row["requestDigest"]), binding,
    reportDigest: digest(row["reportDigest"]), reportByteLength: bytes.byteLength, coverageDigest: reportDigests.coverageDigest, phasesDigest: reportDigests.phasesDigest,
    verdict: report.verdict, releaseEligible: report.releaseEligible, publication: "finalized", promotion: normalizedPromotion };
}
export function decodeCompletion(value: unknown, options: { readonly request: unknown; readonly grant: unknown; readonly finalizedReportBytes: unknown }): GrowthToolingValidated<GrowthAuthorityCompletion> {
  const validated = validateCompletion(value, options);
  return { ...wire(validated), protocolDigest: growthAuthorityCompletionDigest(validated, fingerprint) };
}
export function encodeReceipt(value: unknown, options: { readonly request: unknown; readonly grant: unknown; readonly completion: unknown; readonly finalizedReportBytes: unknown }): GrowthToolingValidatedReceipt {
  const args = optionsRecord(options, ["request", "grant", "completion", "finalizedReportBytes"]);
  const validatedRequest = request(args["request"]);
  const validatedGrant = historicalGrant(args["grant"], validatedRequest);
  const validatedCompletion = validateCompletion(args["completion"], { request: validatedRequest, grant: validatedGrant, finalizedReportBytes: args["finalizedReportBytes"] },
    { request: validatedRequest, grant: validatedGrant });
  const validated = validateGrowthAuthorityReceipt(input(value), validatedCompletion, validatedRequest.operation, fingerprint);
  if (validated.grantId !== validatedGrant.grantId || validated.grantDigest !== growthAuthorityGrantDigest(validatedGrant, fingerprint)
    || validated.requestDigest !== growthAuthorityRequestDigest(validatedRequest, fingerprint)) { invalid("growth-authority-receipt-grant-mismatch"); }
  return wire(validated);
}
