import type {
  GrowthAuthorityBinding,
  GrowthAuthorityGrant,
  GrowthAuthorityRequest,
} from "../model/growth-authority.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { hashGrowthPayload } from "./compare-growth-surfaces.js";
import {
  growthCanonicalJson,
  growthObservationReference,
  growthUniqueSorted,
  normalizeGrowthInvocation,
  normalizeGrowthObservation,
} from "./normalize-growth-observation.js";
import {
  commit,
  digest,
  exact,
  invalid,
  object,
  source,
} from "./validate-growth-authority-primitives.js";
import { validateCustodyEvidence, custodyDigest } from "./growth-authority-packed-evidence.js";

export function validateGrantBase(
  row: Record<string, unknown>,
  binding: GrowthAuthorityBinding,
  fingerprint: ChangeFingerprint,
) {
  const trustedBase = normalizeGrowthObservation(
    row["trustedBase"] as GrowthAuthorityGrant["trustedBase"],
  );
  if (trustedBase.repository !== binding.invocation.repository) {
    invalid("growth-authority-base-repository-mismatch");
  }
  const referenceRow = object(row["trustedBaseReference"], [
    "sourceCommit",
    "sourceTree",
    "surfaceDigest",
    "topologyDigest",
    "lockDigest",
    "toolchainDigest",
    "artifactDigests",
  ]);
  if (!Array.isArray(referenceRow["artifactDigests"])) {
    invalid("growth-authority-base-reference-invalid");
  }
  const trustedBaseReference = {
    sourceCommit: commit(referenceRow["sourceCommit"]),
    sourceTree: commit(referenceRow["sourceTree"]),
    surfaceDigest: digest(referenceRow["surfaceDigest"]),
    topologyDigest: digest(referenceRow["topologyDigest"]),
    lockDigest: digest(referenceRow["lockDigest"]),
    toolchainDigest: digest(referenceRow["toolchainDigest"]),
    artifactDigests: growthUniqueSorted(
      referenceRow["artifactDigests"].map(digest),
      (entry) => entry,
    ),
  };
  exact(
    trustedBaseReference,
    growthObservationReference(trustedBase, fingerprint),
    "growth-authority-base-reference-mismatch",
  );
  const historyValue = row["retainedHistory"];
  const history = object(historyValue, [
    "targetSource",
    "targetSurfaceDigest",
    "receiptDigest",
    "custodyEvidenceDigest",
    "custodyEvidence",
  ]);
  const targetSource = source(history["targetSource"]);
  exact(
    targetSource,
    { commit: trustedBase.sourceCommit, tree: trustedBase.sourceTree },
    "growth-authority-history-source-mismatch",
  );
  if (digest(history["targetSurfaceDigest"]) !== trustedBaseReference.surfaceDigest) {
    invalid("growth-authority-history-target-mismatch");
  }

  return { trustedBase, trustedBaseReference, history, targetSource };
}

export function validateGrantHistoryCustody(
  history: Record<string, unknown>,
  trustedBase: GrowthAuthorityGrant["trustedBase"],
  fingerprint: ChangeFingerprint,
) {
  const historicalCustody = digest(history["custodyEvidenceDigest"]);
  const historicalEvidence = validateCustodyEvidence(history["custodyEvidence"], fingerprint);
  if (custodyDigest(historicalEvidence, fingerprint) !== historicalCustody) {
    invalid("growth-authority-history-custody-mismatch");
  }
  const retainedBase = historicalEvidence.archiveManifest.find(
    (file) => file.path === "trusted-base.json",
  );
  if (retainedBase?.digest !== `sha256:${fingerprint.sha256(growthCanonicalJson(trustedBase))}`) {
    invalid("growth-authority-history-custody-mismatch");
  }
  return { historicalCustody, historicalEvidence };
}

export function validateGrantEvidenceScope(
  request: GrowthAuthorityRequest,
  binding: GrowthAuthorityBinding,
  requestDigest: GrowthAuthorityGrant["requestDigest"],
  evidence: Pick<GrowthAuthorityGrant, "released" | "ownerEvidence" | "archives" | "candidates">,
): void {
  const { released, ownerEvidence, archives, candidates } = evidence;
  const archiveByPackage = new Map(archives.map((entry) => [entry.packageName, entry]));
  const candidateByPackage = new Map(candidates.map((entry) => [entry.packageName, entry]));
  exact(
    released.map((entry) => ({ packageName: entry.packageName, kind: entry.evidence.kind })),
    request.contextSelectors.released.map((entry) => ({
      packageName: entry.packageName,
      kind: entry.kind,
    })),
    "growth-authority-release-selector-mismatch",
  );
  const requestedDecisions = new Set(request.decisionDigests);
  for (const owner of ownerEvidence) {
    if (
      owner.sourceBindingDigest !== requestDigest ||
      !requestedDecisions.has(owner.decisionDigest)
    ) {
      invalid("growth-authority-owner-source-mismatch");
    }
  }
  const packageNames = released.map((entry) => entry.packageName);
  exact(
    candidates.map((entry) => entry.packageName),
    packageNames,
    "growth-authority-candidate-scope-mismatch",
  );
  const releasedPackageNames = released
    .filter((entry) => entry.evidence.kind === "released")
    .map((entry) => entry.packageName);
  exact(
    archives.map((entry) => entry.packageName),
    releasedPackageNames,
    "growth-authority-archive-scope-mismatch",
  );
  for (const releasedRow of released) {
    const candidate = candidateByPackage.get(releasedRow.packageName)!;
    const candidateInvocation = normalizeGrowthInvocation({
      repository: candidate.observation.repository,
      sourceCommit: candidate.observation.sourceCommit,
      sourceTree: candidate.observation.sourceTree,
      topologyDigest: candidate.observation.topologyDigest,
      lockDigest: candidate.observation.lockDigest,
      toolchainDigest: candidate.observation.toolchainDigest,
      artifactDigests: candidate.observation.artifactDigests,
      tool: candidate.observation.tool,
    });
    exact(
      candidateInvocation,
      binding.invocation,
      "growth-authority-candidate-invocation-mismatch",
    );
    exact(
      candidate.source,
      binding.target.evaluation,
      "growth-authority-candidate-source-mismatch",
    );
    if (candidate.packageVersion !== releasedRow.releaseEvidence.packageVersion) {
      invalid("growth-authority-candidate-version-mismatch");
    }
    if (releasedRow.evidence.kind === "initial-unreleased") {
      continue;
    }
    const archive = archiveByPackage.get(releasedRow.packageName)!;
    if (
      releasedRow.evidence.typed.packageVersion !== releasedRow.evidence.artifact.packageVersion ||
      archive.packageVersion !== releasedRow.evidence.artifact.packageVersion
    ) {
      invalid("growth-authority-archive-version-mismatch");
    }
    if (releasedRow.observation === undefined) {
      invalid("growth-authority-release-observation-missing");
    }
    exact(
      archive.observation,
      releasedRow.observation,
      "growth-authority-archive-observation-mismatch",
    );
  }
}

export function validateGrantEvidenceManifest(
  binding: GrowthAuthorityBinding,
  evidence: Pick<GrowthAuthorityGrant, "archives" | "candidates" | "metadataRoots">,
  historicalCustody: GrowthAuthorityGrant["retainedHistory"]["custodyEvidenceDigest"],
  fingerprint: ChangeFingerprint,
): void {
  const { archives, candidates, metadataRoots } = evidence;
  const evidenceManifestDigest = hashGrowthPayload(
    {
      domain: "foundation:sdk-growth:evidence-manifest:2",
      payload: {
        archives: archives.map((entry) => ({
          packageName: entry.packageName,
          custodyEvidenceDigest: entry.custodyEvidenceDigest,
        })),
        candidates: candidates.map((entry) => ({
          packageName: entry.packageName,
          custodyEvidenceDigest: entry.custodyEvidenceDigest,
        })),
        metadataRoots: metadataRoots.map((entry) => ({
          packageName: entry.evidence.packageName,
          evidenceDigest: entry.evidenceDigest,
        })),
        retainedHistory: historicalCustody,
      },
    },
    fingerprint,
  );
  if (evidenceManifestDigest !== binding.evidenceManifestDigest) {
    invalid("growth-authority-evidence-manifest-mismatch");
  }
}
