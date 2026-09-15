import type { GrowthComparison } from "../model/growth-admission.js";
import type { GrowthEvidence, GrowthObservationReference } from "../model/growth-observation.js";
import { GrowthObservationInvariantError, growthDimensions } from "../model/growth-observation.js";
import type { GrowthReport } from "../model/growth-report.js";
import { growthReportPhases } from "../model/growth-report.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { growthTransitionFingerprint } from "./compare-growth-surfaces.js";
import { growthCanonicalJson, growthUniqueSorted } from "./normalize-growth-observation.js";

function invalid(): never { throw new GrowthObservationInvariantError("invalid-growth-report"); }
function closed(value: object, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) { invalid(); }
}
function text(value: string): void { if (typeof value !== "string" || !value.trim() || value.length > 4096) { invalid(); } }
function digest(value: string): void { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) { invalid(); } }
function oneOf(value: string, choices: readonly string[]): void { if (!choices.includes(value)) { invalid(); } }
function reasons(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) { invalid(); }
  values.forEach(text); return growthUniqueSorted(values, (value) => value);
}
function evidence<T>(input: GrowthEvidence<T>, normalize: (value: T) => T): GrowthEvidence<T> {
  if (input.status === "available") { closed(input, ["status", "value"]); return { status: "available", value: normalize(input.value) }; }
  if (input.status !== "unavailable") { invalid(); }
  closed(input, ["status", "reasons"]); return { status: "unavailable", reasons: reasons(input.reasons) };
}
function reference(value: GrowthObservationReference): GrowthObservationReference {
  closed(value, ["sourceCommit", "sourceTree", "surfaceDigest", "topologyDigest", "lockDigest", "toolchainDigest", "artifactDigests"]);
  if (!/^[a-f0-9]{40}$/u.test(value.sourceCommit) || !/^[a-f0-9]{40}$/u.test(value.sourceTree)) { invalid(); }
  [value.surfaceDigest, value.topologyDigest, value.lockDigest, value.toolchainDigest, ...value.artifactDigests].forEach(digest);
  return { ...value, artifactDigests: growthUniqueSorted(value.artifactDigests, (entry) => entry) };
}
function comparison(value: GrowthComparison, fingerprint: ChangeFingerprint): GrowthComparison {
  oneOf(value.status, ["complete", "incomplete"]);
  closed(value, value.status === "complete" ? ["status", "before", "after", "transitions"] : ["status", "reasons", "findings"]);
  const rows = value.status === "complete" ? value.transitions : value.findings;
  for (const row of rows) {
    closed(row, ["coordinate", "before", "after", "policyVersion", "fingerprint"]);
    if (row.policyVersion !== "foundation:sdk-growth:policy:1" || growthTransitionFingerprint(row, fingerprint) !== row.fingerprint) { invalid(); }
  }
  growthUniqueSorted(rows, (row) => row.fingerprint);
  const ordered = growthUniqueSorted(rows, (row) => growthCanonicalJson(row.coordinate));
  if (value.status === "complete") { digest(value.before); digest(value.after); return { ...value, transitions: ordered }; }
  return { ...value, reasons: reasons(value.reasons), findings: ordered };
}

/** Validate the complete closed artifact before serialization/publication. */
export function validateGrowthReport(report: GrowthReport, fingerprint: ChangeFingerprint): GrowthReport {
  closed(report, ["contractRevision", "policyVersion", "repository", "trustedBase", "candidate", "released", "tool", "authority", "coverage", "trustedBaseComparison", "releasedComparison", "transitionReceipts", "phases", "verdict", "releaseEligible"]);
  if (report.contractRevision !== "foundation:sdk-growth:c0:5" || report.policyVersion !== "foundation:sdk-growth:policy:1") { invalid(); }
  text(report.repository); closed(report.tool, ["version", "artifactDigest", "extractorVersion"]);
  text(report.tool.version); text(report.tool.extractorVersion); digest(report.tool.artifactDigest);
  const trustedBase = evidence(report.trustedBase, reference), candidate = evidence(report.candidate, reference);
  const released = growthUniqueSorted(report.released, (row) => row.packageName).map((row) => {
    closed(row, ["packageName", "evidence"]); text(row.packageName);
    if (row.evidence.kind === "released") {
      closed(row.evidence, ["kind", "observation"]);
      return { ...row, evidence: { kind: "released" as const, observation: evidence(row.evidence.observation, reference) } };
    }
    if (row.evidence.kind !== "initial-unreleased") { invalid(); }
    closed(row.evidence, ["kind", "history"]);
    return { ...row, evidence: { kind: "initial-unreleased" as const, history: evidence(row.evidence.history, (value) => { digest(value); return value; }) } };
  });
  const authority = validateAuthority(report.authority);
  const coverage = growthUniqueSorted(report.coverage, (row) => row.packageName).map((row) => {
    closed(row, ["packageName", "classification", "dimensions"]); text(row.packageName); oneOf(row.classification, ["governed", "private-only"]);
    const dimensions = growthUniqueSorted(row.dimensions, (entry) => entry.dimension).map((entry) => {
      closed(entry, ["dimension", "status", "reasons"]); oneOf(entry.dimension, growthDimensions); oneOf(entry.status, ["complete", "limited", "unsupported", "unavailable"]);
      return { ...entry, reasons: entry.status === "complete" && entry.reasons.length === 0 ? [] : reasons(entry.reasons) };
    });
    if (dimensions.length !== growthDimensions.length) { invalid(); }
    return { ...row, dimensions };
  });
  const trustedBaseComparison = comparison(report.trustedBaseComparison, fingerprint), releasedComparison = comparison(report.releasedComparison, fingerprint);
  if (report.phases.length !== growthReportPhases.length) { invalid(); }
  report.phases.forEach((phase, index) => { closed(phase, ["name", "status"]); if (phase.name !== growthReportPhases[index]) { invalid(); } oneOf(phase.status, ["complete", "failed", "unavailable"]); });
  oneOf(report.verdict, ["admitted", "rejected", "incomplete"]);
  if (typeof report.releaseEligible !== "boolean") { invalid(); }
  const incomplete = trustedBase.status !== "available" || candidate.status !== "available" || authority.status !== "verified"
    || trustedBaseComparison.status !== "complete" || releasedComparison.status !== "complete" || report.phases.some((phase) => phase.status === "unavailable")
    || coverage.length === 0 || coverage.some((row) => row.dimensions.some((entry) => entry.status !== "complete"));
  if (incomplete && report.verdict !== "incomplete") { invalid(); }
  if (report.verdict !== "admitted" && (report.transitionReceipts.length !== 0 || report.releaseEligible)) { invalid(); }
  const transitionReceipts = growthUniqueSorted(report.transitionReceipts, (row) => growthCanonicalJson([row.before, row.after])).map((row) => {
    closed(row, ["before", "after", "decisions", "transitions", "trustedRunRef"]); digest(row.before); digest(row.after); text(row.trustedRunRef);
    row.decisions.forEach(digest); row.transitions.forEach(digest);
    const transitions = growthUniqueSorted(row.transitions, (value) => value), decisions = growthUniqueSorted(row.decisions, (value) => value);
    if (authority.status !== "verified" || row.trustedRunRef !== authority.runRef || trustedBaseComparison.status !== "complete"
      || row.before !== trustedBaseComparison.before || row.after !== trustedBaseComparison.after
      || growthCanonicalJson(transitions) !== growthCanonicalJson(trustedBaseComparison.transitions.map((entry) => entry.fingerprint).toSorted())) { invalid(); }
    return { ...row, transitions, decisions };
  });
  if (report.verdict === "admitted" && (transitionReceipts.length !== 1 || report.phases.some((phase) => phase.status !== "complete"))) { invalid(); }
  return { ...report, trustedBase, candidate, released, authority, coverage, trustedBaseComparison, releasedComparison, transitionReceipts };
}

function validateAuthority(input: GrowthReport["authority"]): GrowthReport["authority"] {
  const authority = input.status === "verified" ? input : { ...input, reasons: reasons(input.reasons) };
  if (authority.status === "verified") {
    closed(authority, ["status", "workflowRef", "runRef", "receiptDigest"]); text(authority.workflowRef); text(authority.runRef); digest(authority.receiptDigest);
  } else { oneOf(authority.status, ["unverified"]); closed(authority, ["status", "reasons"]); }
  return authority;
}
