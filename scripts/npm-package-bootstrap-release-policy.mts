import { NPM_PACKAGE_BOOTSTRAP, fail } from "./npm-package-bootstrap-catalog.mjs";
import { auditLivePackage, livePackageEvidence } from "./npm-package-bootstrap-registry.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";
import {
  comparePublishedVersions,
  parsePublishedVersion,
  parseStableVersion,
} from "./release-publish-registry-version.mjs";
import {
  assertPredecessorInventory,
  type ReleasePredecessor,
} from "./npm-package-bootstrap-successor.mts";

type BootstrapProfile = {
  approval: { archiveIntegrity: string } | null;
  bootstrapVersion: string;
  id: string;
  name: string;
  provenance: { ref: string; workflowPath: string };
  releasePredecessor: ReleasePredecessor | null;
  state: string;
  [key: string]: unknown;
};

type ReleaseState = {
  packages: {
    private: readonly { manifestBytes: string }[];
    public: readonly { manifestBytes: string }[];
  };
};

type RegistryState = readonly { name: string; versions: readonly string[] }[];

type VerifiedProvenance = {
  commit: string;
  ref: string;
  repository: string;
  sha512: string;
  workflow: string;
};

type SuccessorVerificationOptions = {
  auditPackage?: (profile: BootstrapProfile, temporaryRoot?: string) => Promise<unknown>;
  fetchImplementation?: typeof fetch;
  observationOptions?: Record<string, unknown>;
  profile: BootstrapProfile;
  temporaryRoot?: string;
};

function refuse(message: string): never {
  fail(message);
  throw new Error(message);
}

export function assertProvenanceBinding({
  auditEvidence,
  expectedCommit,
  profile,
}: {
  auditEvidence: unknown;
  expectedCommit?: string;
  profile: BootstrapProfile;
}): string {
  if (profile.approval === null) {
    return refuse(`${profile.name} has no reviewed provenance approval.`);
  }
  let provenance: VerifiedProvenance;
  try {
    const result: unknown = verifiedProvenanceFromNpmAudit(
      auditEvidence,
      {
        integrity: profile.approval.archiveIntegrity,
        name: profile.name,
        version: profile.bootstrapVersion,
      },
      {
        ref: profile.provenance.ref,
        repository: NPM_PACKAGE_BOOTSTRAP.repository,
        workflow: profile.provenance.workflowPath,
      },
    );
    provenance = result as VerifiedProvenance;
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "npm provenance verification failed.");
  }
  if (expectedCommit !== undefined && provenance.commit !== expectedCommit) {
    return refuse("SLSA provenance is not bound to the expected reviewed commit.");
  }
  return provenance.commit;
}

export function reviewedSuccessorPredecessor(
  profile: BootstrapProfile,
  releaseVersion: string,
): ReleasePredecessor | null {
  if (
    profile.id !== "ci-input-proof" ||
    profile.releasePredecessor === null ||
    parseStableVersion(releaseVersion) === undefined
  ) {
    return null;
  }
  const target = parsePublishedVersion(releaseVersion);
  const predecessor = parsePublishedVersion(profile.releasePredecessor.version);
  return target !== undefined && predecessor !== undefined && comparePublishedVersions(target, predecessor) > 0
    ? profile.releasePredecessor
    : null;
}

export function assertBootstrapRegistryVersionHistory(
  profile: BootstrapProfile,
  versions: unknown,
): readonly string[] {
  if (
    !Array.isArray(versions) ||
    versions.some((version) => typeof version !== "string" || version === "") ||
    new Set(versions).size !== versions.length
  ) {
    return refuse(`${profile.name} registry history has an invalid version inventory.`);
  }
  const versionInventory = versions as string[];
  const reviewedStageHistory =
    profile.id === "ci-input-proof" &&
    profile.name === "@agent-teams/ci-input-proof" &&
    profile.releasePredecessor?.version === "0.1.0-rc.0";
  const legacyVersions = versionInventory.filter((version) => version === "0.0.0-stage");
  if (legacyVersions.length > 0 && !reviewedStageHistory) {
    return refuse(`${profile.name} registry history contains an unsupported version.`);
  }
  const publishedVersions = versionInventory.filter((version) => version !== "0.0.0-stage");
  if (publishedVersions.some((version) => parsePublishedVersion(version) === undefined)) {
    return refuse(`${profile.name} registry history contains an unsupported version.`);
  }
  return Object.freeze(publishedVersions) as readonly string[];
}

export function assertBootstrapReleasePolicy(
  state: ReleaseState,
  registryState: RegistryState,
  catalog: { packages: readonly BootstrapProfile[] } = NPM_PACKAGE_BOOTSTRAP,
): void {
  const manifests = [...state.packages.private, ...state.packages.public]
    .map((entry) => JSON.parse(entry.manifestBytes) as { name: string; version: string });
  for (const profile of catalog.packages) {
    const manifest = manifests.find((entry) => entry.name === profile.name);
    if (manifest === undefined) {
      continue;
    }
    if (profile.state === "candidate" || profile.approval === null) {
      fail(`${profile.name} release requires reviewed bootstrap approval.`);
    }
    const registry = registryState.find((entry) => entry.name === profile.name);
    if (registry === undefined) {
      return refuse(`${profile.name} registry state is missing.`);
    }
    assertBootstrapRegistryVersionHistory(profile, registry.versions);
    const predecessor = reviewedSuccessorPredecessor(profile, manifest.version);
    const baselineVersion = predecessor !== null
      ? predecessor.version
      : profile.bootstrapVersion;
    if (!registry.versions.includes(baselineVersion)) {
      fail(`${profile.name} release requires its immutable ${baselineVersion} npm baseline.`);
    }
  }
}

export async function verifySuccessorReleaseBaseline({
  auditPackage = auditLivePackage,
  fetchImplementation = fetch,
  observationOptions,
  profile,
  temporaryRoot,
}: SuccessorVerificationOptions): Promise<ReleasePredecessor> {
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
  }) as BootstrapProfile;
  const observation = { ...observationOptions, retryNotFound: true };
  const initialEvidence = await livePackageEvidence(predecessorProfile, fetchImplementation, observation);
  if (initialEvidence === null) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor is absent from npm.`);
  }
  if (!initialEvidence.metadata.versions.includes(predecessor.version)) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor is absent from npm.`);
  }
  const auditEvidence = await auditPackage(predecessorProfile, temporaryRoot);
  const evidence = await livePackageEvidence(predecessorProfile, fetchImplementation, observation);
  if (evidence === null) {
    return refuse(`${predecessor.name}@${predecessor.version} predecessor became absent during verification.`);
  }
  if (!evidence.metadata.versions.includes(predecessor.version)) {
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
  return assertPredecessorInventory(predecessor, observed);
}
