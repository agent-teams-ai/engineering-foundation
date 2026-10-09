import { fail } from "./npm-package-bootstrap-catalog.mjs";
import { auditLivePackage, livePackageEvidence } from "./npm-package-bootstrap-registry.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";
import {
  comparePublishedVersions,
  parsePublishedVersion,
} from "./release-publish-registry-version.mjs";

type Provenance = {
  ref: string;
  repository: string;
  sourceCommit: string;
  workflowPath: string;
};

type ReleasePredecessor = {
  archiveIntegrity: string;
  name: string;
  provenance: Provenance;
  version: string;
};

type BootstrapProfile = {
  id: string;
  name: string;
  releasePredecessor: ReleasePredecessor | null;
  [key: string]: unknown;
};

type VerifiedProvenance = {
  commit: string;
  ref: string;
  repository: string;
  sha512: string;
  workflow: string;
};

function refuse(message: string): never {
  fail(message);
  throw new Error(message);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).toSorted().join("\0") !== [...expected].toSorted().join("\0")
  ) {
    fail(`${label} has an unexpected inventory shape.`);
  }
}

export function assertPredecessorInventory(expected: unknown, observed: unknown): ReleasePredecessor {
  const inventoryKeys = ["archiveIntegrity", "name", "provenance", "version"];
  const provenanceKeys = ["ref", "repository", "sourceCommit", "workflowPath"];
  assertExactKeys(expected, inventoryKeys, "expected predecessor");
  assertExactKeys(observed, inventoryKeys, "observed predecessor");
  assertExactKeys(expected.provenance, provenanceKeys, "expected predecessor provenance");
  assertExactKeys(observed.provenance, provenanceKeys, "observed predecessor provenance");
  for (const key of inventoryKeys.filter((entry) => entry !== "provenance")) {
    if (expected[key] !== observed[key]) {
      fail(`predecessor ${key} differs from the exact reviewed inventory.`);
    }
  }
  for (const key of provenanceKeys) {
    if (expected.provenance[key] !== observed.provenance[key]) {
      fail(`predecessor provenance ${key} differs from the exact reviewed inventory.`);
    }
  }
  return Object.freeze({
    archiveIntegrity: observed.archiveIntegrity as string,
    name: observed.name as string,
    provenance: Object.freeze({ ...(observed.provenance as Provenance) }),
    version: observed.version as string,
  });
}

export function reviewedSuccessorPredecessor(
  profile: BootstrapProfile,
  releaseVersion: string,
): ReleasePredecessor | null {
  if (profile.id !== "ci-input-proof" || profile.releasePredecessor === null) {
    return null;
  }
  const target = parsePublishedVersion(releaseVersion);
  const predecessor = parsePublishedVersion(profile.releasePredecessor.version);
  return target !== undefined && predecessor !== undefined && comparePublishedVersions(target, predecessor) > 0
    ? profile.releasePredecessor
    : null;
}

export async function verifySuccessorReleaseBaseline({
  auditPackage = auditLivePackage,
  fetchImplementation = fetch,
  observationOptions,
  profile,
  temporaryRoot,
}: {
  auditPackage?: (profile: BootstrapProfile, temporaryRoot?: string) => Promise<unknown>;
  fetchImplementation?: typeof fetch;
  observationOptions?: Record<string, unknown>;
  profile: BootstrapProfile;
  temporaryRoot?: string;
}): Promise<ReleasePredecessor> {
  const predecessor = profile.releasePredecessor;
  if (predecessor === null) {
    return refuse(`${profile.name} has no reviewed successor predecessor.`);
  }
  const predecessorProfile = Object.freeze({
    ...profile,
    bootstrapVersion: predecessor.version,
    provenance: Object.freeze({
      ref: predecessor.provenance.ref,
      workflowPath: predecessor.provenance.workflowPath,
    }),
    releasePredecessor: null,
  });
  const observation = { ...observationOptions, retryNotFound: true };
  const initialEvidence = await livePackageEvidence(predecessorProfile, fetchImplementation, observation);
  if (initialEvidence === null || !initialEvidence.metadata.versions.includes(predecessor.version)) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor is absent from npm.`);
  }
  const auditEvidence = await auditPackage(predecessorProfile, temporaryRoot);
  const evidence = await livePackageEvidence(predecessorProfile, fetchImplementation, observation);
  if (evidence === null || !evidence.metadata.versions.includes(predecessor.version)) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor became absent during verification.`);
  }
  if (evidence.integrity !== predecessor.archiveIntegrity) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor archive SRI differs from reviewed evidence.`);
  }
  const provenanceResult: unknown = verifiedProvenanceFromNpmAudit(
    auditEvidence,
    {
      integrity: predecessor.archiveIntegrity,
      name: predecessor.name,
      version: predecessor.version,
    },
    {
      ref: predecessor.provenance.ref,
      repository: predecessor.provenance.repository,
      workflow: predecessor.provenance.workflowPath,
    },
  );
  const provenance = provenanceResult as VerifiedProvenance;
  if (evidence.gitHead !== null && evidence.gitHead !== provenance.commit) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor npm gitHead contradicts signed provenance.`);
  }
  if (provenance.commit !== predecessor.provenance.sourceCommit) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor source commit differs from reviewed provenance.`);
  }
  const observed = {
    archiveIntegrity: predecessor.archiveIntegrity,
    name: predecessor.name,
    provenance: {
      ref: provenance.ref,
      repository: provenance.repository,
      sourceCommit: provenance.commit,
      workflowPath: provenance.workflow,
    },
    version: predecessor.version,
  };
  const provenanceArchiveIntegrity = `sha512-${Buffer.from(provenance.sha512, "hex").toString("base64")}`;
  if (provenanceArchiveIntegrity !== evidence.integrity) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor archive SRI differs from signed provenance.`);
  }
  assertPredecessorInventory(predecessor, observed);
  return Object.freeze(observed);
}
