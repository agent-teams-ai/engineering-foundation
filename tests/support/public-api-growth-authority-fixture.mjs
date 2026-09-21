import { createHash } from "node:crypto";
import { hashGrowthPayload } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
import { growthCanonicalJson, growthObservationReference, normalizeGrowthObservation } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import { growthAuthorityRequestDigest } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { growthDimensions } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";

export const schemaVersion = "reviewrouter:sdk-growth-authority:3";
export const fingerprint = {
  sha256: value => createHash("sha256").update(value).digest("hex"),
  sha512Integrity: value => `sha512-${createHash("sha512").update(value).digest("base64")}`
};
export const d = character => `sha256:${character.repeat(64)}`;
const phases = ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"];
export const invocation = {
  repository: "github:123", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40),
  topologyDigest: d("1"), lockDigest: d("2"), toolchainDigest: d("3"), artifactDigests: [d("4")],
  tool: { version: "1.3.3", artifactDigest: d("5"), extractorVersion: "7.58.12" }
};
export const binding = () => ({ invocation: structuredClone(invocation), target: {
  repository: { provider: "github", repositoryId: "123", owner: "agent-teams-ai", name: "engineering-foundation" },
  pullRequestNumber: 44, head: { commit: "1".repeat(40), tree: "2".repeat(40) },
  base: { commit: "3".repeat(40), tree: "4".repeat(40) }, mergeBase: { commit: "5".repeat(40), tree: "6".repeat(40) },
  evaluation: { commit: "1".repeat(40), tree: "2".repeat(40) }, evaluationKind: "head"
}, verifier: { identity: "reviewrouter/sdk-growth-authority", immutableRevision: "7".repeat(40), artifactDigest: d("6") },
tool: { packageName: "@agent-teams/engineering-foundation", version: "1.3.3", archiveDigest: d("7"),
  archiveIntegrity: `sha512-${"A".repeat(86)}==`, distributionDigest: d("5"), extractorVersion: "7.58.12" },
policy: { contractRevision: "foundation:sdk-growth:c0:5", policyVersion: "foundation:sdk-growth:policy:1",
  enrollmentRevision: "8".repeat(40), configurationDigest: d("8"), scopeDigest: d("9"), commandDigest: d("a") },
historyDigest: d("b"), evidenceManifestDigest: evidenceManifest([], [], custody({ "trusted-base.json": growthCanonicalJson(normalizeGrowthObservation(observation())) })) });

export function observation(packageName = "fixture", status = "complete") {
  return { ...structuredClone(invocation), contractRevision: "foundation:sdk-growth:c0:5",
    observationVersion: "foundation:sdk-growth:observation:1", coverage: [{ packageName, classification: "governed",
      dimensions: growthDimensions.map(dimension => dimension === "decision"
        ? { dimension, status: "unavailable", reasons: ["s3-pending"] }
        : { dimension, status, reasons: [status === "complete" ? "observed" : "incomplete"] }) }], entries: [] };
}
export function authoritySnapshot(packageName = "fixture") {
  return { schemaVersion: 1, packageName, packageVersion: "0.9.0", extractorVersion: "7.58.12", entrypoints: [] };
}
export function custody(contents) {
  const files = Object.entries(contents).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, content]) => ({ path, contentHex: Buffer.from(content).toString("hex") }));
  const archivePayload = growthCanonicalJson({ schemaVersion: "foundation:sdk-growth:archive:1", files });
  const archiveDigest = `sha256:${fingerprint.sha256(archivePayload)}`, archiveIntegrity = fingerprint.sha512Integrity(archivePayload);
  const archiveManifest = files.map(file => ({ path: file.path, digest: `sha256:${fingerprint.sha256(Buffer.from(file.contentHex, "hex"))}` }));
  return { archiveDigest, archiveIntegrity, archivePayload, archiveManifest, installedFiles: structuredClone(archiveManifest) };
}
const evidenceManifestRows = values => values.map(entry => ({ packageName: entry.packageName, custodyEvidenceDigest: entry.custodyEvidenceDigest }))
  .toSorted((a, b) => a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0);
function evidenceManifest(archives, candidates, historicalCustody, metadataRoots = []) {
  return hashGrowthPayload({ domain: "foundation:sdk-growth:evidence-manifest:2", payload: {
    archives: evidenceManifestRows(archives), candidates: evidenceManifestRows(candidates),
    metadataRoots: metadataRoots.map(root => ({ packageName: root.evidence.packageName, evidenceDigest: root.evidenceDigest })),
    retainedHistory: hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: historicalCustody }, fingerprint)
  } }, fingerprint);
}
export function sealEvidence(value, req) {
  req.binding.evidenceManifestDigest = evidenceManifest(value.archives, value.candidates, value.retainedHistory.custodyEvidence, value.metadataRoots);
  value.binding = structuredClone(req.binding);
  value.requestDigest = growthAuthorityRequestDigest(req, fingerprint);
}
export function packed(packageName, packageVersion, observed = observation(packageName), bytes = `candidate:${packageName}:${packageVersion}`) {
  const normalized = normalizeGrowthObservation(observed);
  const custodyEvidence = custody({ "package.json": JSON.stringify({ name: packageName, version: packageVersion }), "content.txt": bytes });
  const { archiveDigest, archiveIntegrity } = custodyEvidence;
  const observationDigest = growthObservationReference(normalized, fingerprint).surfaceDigest;
  const source = { commit: normalized.sourceCommit, tree: normalized.sourceTree };
  const custodyEvidenceDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: custodyEvidence }, fingerprint);
  return { packageName, packageVersion, source, archiveDigest, archiveIntegrity, observation: normalized,
    observationDigest, coverage: normalized.coverage[0], custodyEvidence, custodyEvidenceDigest,
    installedDistribution: { packageName, packageVersion, source, archiveDigest, archiveIntegrity, observationDigest } };
}
export function request(operation = "check") {
  return { schemaVersion, kind: "request", operation,
    admissionReceiptId: operation === "check" ? null : "receipt-check", binding: binding(),
    contextSelectors: { trustedBasePath: "evidence/base.json", decisionsPath: "evidence/decisions.json", released: [] },
    decisionDigests: [], requiredPhases: phases };
}
export function grant(req = request()) {
  const base = observation();
  const custodyEvidence = custody({ "trusted-base.json": growthCanonicalJson(normalizeGrowthObservation(base)) });
  return { schemaVersion, kind: "grant", grantId: "grant-1",
    requestDigest: growthAuthorityRequestDigest(req, fingerprint), admissionReceipt: { kind: "none" }, binding: structuredClone(req.binding),
    workflowRef: "reviewrouter/sdk-growth-authority.yml@refs/heads/main", runRef: "run/1", issuedAt: "2026-09-16T10:00:00Z",
    expiresAt: "2026-09-16T12:00:00Z", trustedBase: base, trustedBaseReference: growthObservationReference(base, fingerprint),
    retainedHistory: { targetSource: { commit: base.sourceCommit, tree: base.sourceTree },
      targetSurfaceDigest: growthObservationReference(base, fingerprint).surfaceDigest, receiptDigest: d("d"), custodyEvidence, custodyEvidenceDigest: hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: custodyEvidence }, fingerprint) },
    released: [], ownerEvidence: [], archives: [], candidates: [], metadataRoots: [], requiredCoverageDigest: d("e"), requiredPhases: phases };
}
export function initialPackage(value, req, packageName = "fixture", bytes) {
  req.contextSelectors.released.push({ packageName, kind: "initial-unreleased", trustedHistoryPath: `evidence/${packageName}.json` });
  value.released.push({ packageName, releaseEvidence: { packageName, packageVersion: "0.0.0", declaredBump: "minor" },
    evidence: { kind: "initial-unreleased", historyDigest: req.binding.historyDigest } });
  value.candidates.push(packed(packageName, "0.0.0", observation(packageName), bytes));
}
export function releasedPackage(value, req, packageName = "fixture") {
  req.contextSelectors.released.push({ packageName, kind: "released", observationPath: `evidence/${packageName}.json` });
  const historic = observation(packageName);
  const typed = { schemaVersion: 1, packageName, packageVersion: "0.9.0", extractorVersion: "7.58.12", entrypoints: [] };
  const artifact = { ...typed, extractorVersion: "package-artifact-inventory/1" };
  value.released.push({ packageName, releaseEvidence: { packageName, packageVersion: "1.0.0", declaredBump: "minor" },
    observation: historic, evidence: { kind: "released", typed, artifact } });
  value.archives.push(packed(packageName, "0.9.0", historic, `historic:${packageName}`));
  value.candidates.push(packed(packageName, "1.0.0", observation(packageName), `candidate:${packageName}`));
}
export const now = new Date("2026-09-16T11:00:00Z");
