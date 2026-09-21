import type { GrowthAuthorityBinding, GrowthAuthorityMetadataRoot, GrowthMetadataRootSource } from "../model/growth-authority.js";
import type { GrowthInvocation, GrowthSurfaceObservation } from "../model/growth-observation.js";
import { growthDimensions } from "../model/growth-observation.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { hashGrowthPayload } from "./compare-growth-surfaces.js";
import { growthCanonicalJson, normalizeGrowthObservation } from "./normalize-growth-observation.js";
import { projectGrowthPackage } from "./project-growth-package.js";
import { array, digest, exact, invalid, object, repositoryPath, source, text } from "./validate-growth-authority-primitives.js";

function sourceText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 1024 * 1024) {
    invalid("growth-metadata-root-source-bytes-invalid");
  }
  return value;
}

function sourceBytes(value: unknown): GrowthMetadataRootSource {
  const row = object(value, ["source", "manifestBytes", "workspaceBytes", "classificationBytes"]);
  return { source: source(row["source"]), manifestBytes: sourceText(row["manifestBytes"]),
    workspaceBytes: sourceText(row["workspaceBytes"]), classificationBytes: sourceText(row["classificationBytes"]) };
}

function manifest(bytes: string, packageName: string): { readonly moduleType: "module" | "commonjs" } {
  let value: unknown;
  try { value = JSON.parse(bytes) as unknown; } catch { invalid("growth-metadata-root-manifest-invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) { invalid("growth-metadata-root-manifest-invalid"); }
  const row = value as Record<string, unknown>;
  // This is a deliberately narrow root envelope, not general no-exports or
  // private-package semantics. Any potential exposure needs a separate contract.
  if (row["name"] !== packageName || row["private"] !== true
    || ["exports", "main", "module", "types", "typings", "bin", "browser", "source", "files", "imports", "unpkg", "jsdelivr"]
      .some((key) => Object.hasOwn(row, key))
    || (row["type"] !== undefined && row["type"] !== "module" && row["type"] !== "commonjs")) {
    invalid("growth-metadata-root-exposure-invalid");
  }
  return { moduleType: row["type"] === "module" ? "module" : "commonjs" };
}

/** A distinct release role; full topology remains governed in the unchanged
 * observation/report wire vocabulary. Coverage reasons identify this proof. */
export function metadataRootObservation(root: GrowthAuthorityMetadataRoot, side: "base" | "candidate",
  invocation: GrowthInvocation, fingerprint: ChangeFingerprint): GrowthSurfaceObservation {
  const { packageName } = root.evidence;
  const { moduleType } = manifest(root.evidence[side].manifestBytes, packageName);
  const topology = projectGrowthPackage({ pkg: { name: packageName, rootPath: ".", manifestPath: "package.json", moduleType,
    exportSurface: { explicit: false, entries: [] } }, subject: undefined, retained: undefined }, fingerprint);
  return normalizeGrowthObservation({ ...invocation, contractRevision: "foundation:sdk-growth:c0:5",
    observationVersion: "foundation:sdk-growth:observation:1",
    coverage: [{ packageName, classification: "governed", dimensions: growthDimensions.map((dimension) => ({
      dimension, status: dimension === "decision" ? "unavailable" : "complete",
      reasons: [dimension === "decision" ? "s1-decision-evidence-unavailable" : "qualified-non-release-metadata-root"]
    })) }], entries: topology.entries });
}

function classification(bytes: string, packageName: string): Record<string, unknown> {
  let declaration: unknown;
  try { declaration = JSON.parse(bytes) as unknown; } catch { invalid("growth-metadata-root-classification-invalid"); }
  const record = object(declaration, ["schemaVersion", "kind", "packageName", "rootPath", "manifestPath", "decisionId", "ownerRef", "releaseHistory"]);
  if (bytes !== growthCanonicalJson(record) || record["schemaVersion"] !== "foundation:sdk-growth:metadata-root:1"
    || record["kind"] !== "non-release-metadata-root" || record["packageName"] !== packageName || record["rootPath"] !== "."
    || record["manifestPath"] !== "package.json" || record["releaseHistory"] !== "none") { invalid("growth-metadata-root-classification-invalid"); }
  return record;
}

function validateGrowthMetadataRoot(value: unknown, binding: GrowthAuthorityBinding,
  base: GrowthSurfaceObservation, requestDigest: string, fingerprint: ChangeFingerprint): GrowthAuthorityMetadataRoot {
  const row = object(value, ["evidence", "evidenceDigest", "ownerEvidence"]);
  const evidence = object(row["evidence"], ["kind", "packageName", "rootPath", "manifestPath", "classificationPath", "historyDigest", "base", "candidate"]);
  if (evidence["kind"] !== "non-release-metadata-root" || evidence["rootPath"] !== "." || evidence["manifestPath"] !== "package.json") {
    invalid("growth-metadata-root-classification-invalid");
  }
  const historyDigest = digest(evidence["historyDigest"]);
  if (historyDigest !== binding.historyDigest) { invalid("growth-metadata-root-history-mismatch"); }
  const packageName = text(evidence["packageName"]), classificationPath = repositoryPath(evidence["classificationPath"]);
  if (classificationPath === "package.json" || classificationPath === "pnpm-workspace.yaml") { invalid("growth-metadata-root-classification-invalid"); }
  const previous = sourceBytes(evidence["base"]), candidate = sourceBytes(evidence["candidate"]);
  exact(previous.source, { commit: base.sourceCommit, tree: base.sourceTree }, "growth-metadata-root-source-mismatch");
  exact(candidate.source, binding.target.evaluation, "growth-metadata-root-source-mismatch");
  if (previous.workspaceBytes !== candidate.workspaceBytes || previous.classificationBytes !== candidate.classificationBytes) {
    invalid("growth-metadata-root-reclassified-or-workspace-changed");
  }
  manifest(previous.manifestBytes, packageName); manifest(candidate.manifestBytes, packageName);
  const record = classification(candidate.classificationBytes, packageName);
  const owner = object(row["ownerEvidence"], ["decisionId", "ownerRef", "decisionDigest", "authenticatedSubjectId", "authorizationEvidenceDigest", "approvalEvidenceDigest", "sourceBindingDigest"]);
  const normalized: GrowthAuthorityMetadataRoot = {
    evidence: { kind: "non-release-metadata-root", packageName, rootPath: ".", manifestPath: "package.json", classificationPath, historyDigest,
      base: previous, candidate }, evidenceDigest: digest(row["evidenceDigest"]),
    ownerEvidence: { decisionId: text(owner["decisionId"]), ownerRef: text(owner["ownerRef"]), decisionDigest: digest(owner["decisionDigest"]),
      authenticatedSubjectId: text(owner["authenticatedSubjectId"]), authorizationEvidenceDigest: digest(owner["authorizationEvidenceDigest"]),
      approvalEvidenceDigest: digest(owner["approvalEvidenceDigest"]), sourceBindingDigest: digest(owner["sourceBindingDigest"]) }
  };
  const expectedDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:metadata-root:1", evidence: normalized.evidence }, fingerprint);
  if (normalized.evidenceDigest !== expectedDigest || normalized.ownerEvidence.decisionDigest !== expectedDigest
    || normalized.ownerEvidence.sourceBindingDigest !== requestDigest || normalized.ownerEvidence.ownerRef !== record["ownerRef"]
    || normalized.ownerEvidence.decisionId !== record["decisionId"]) { invalid("growth-metadata-root-owner-evidence-mismatch"); }
  const projected = metadataRootObservation(normalized, "base", base, fingerprint);
  exact(projected.coverage, base.coverage.filter((entry) => entry.packageName === packageName), "growth-metadata-root-base-coverage-mismatch");
  exact(projected.entries, base.entries.filter((entry) => entry.coordinate.packageName === packageName), "growth-metadata-root-base-topology-mismatch");
  return normalized;
}

export function validateGrowthMetadataRoots(value: unknown, input: { readonly binding: GrowthAuthorityBinding;
  readonly base: GrowthSurfaceObservation; readonly requestDigest: string; readonly releaseScope: ReadonlySet<string> },
  fingerprint: ChangeFingerprint): readonly GrowthAuthorityMetadataRoot[] {
  const roots = array(value, 1, "growth-metadata-root-scope-invalid")
    .map((entry) => validateGrowthMetadataRoot(entry, input.binding, input.base, input.requestDigest, fingerprint));
  for (const root of roots) {
    if (input.releaseScope.has(root.evidence.packageName)) { invalid("growth-metadata-root-release-obligation-conflict"); }
  }
  return roots;
}
