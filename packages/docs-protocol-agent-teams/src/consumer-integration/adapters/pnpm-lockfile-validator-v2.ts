import {
  QUALIFIED_DOCS_COHORT_V2_EDGES,
  qualifiedDocsCohortV2PackageEntries,
  type ConsumerIntegrationDesiredStateV3,
  type ManagedSuccessorProfile,
  type QualifiedDocsCohortBindingV2
} from "../application-api.js";
import { assertQualifiedPnpmLockfileTargets } from "./pnpm-lockfile-validator-v1.js";
import { computePnpmRuntimeClosureDigestV2 } from "./pnpm-runtime-closure-v2.js";

const MAXIMUM_LOCKFILE_BYTES = 32 * 1024 * 1024;

function validateQualifiedPnpmLockfileV2(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile,
  enforceRuntimeClosureDigest: boolean
): `sha256:${string}` {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_LOCKFILE_BYTES) {
    throw new TypeError(
      `Qualification v3 lockfile must contain 1..${MAXIMUM_LOCKFILE_BYTES} bytes.`
    );
  }
  const entries = qualifiedDocsCohortV2PackageEntries(
    desired.cohort as unknown as QualifiedDocsCohortBindingV2
  );
  const expectedRuntimeClosureDigest = desired.schemaVersion === 3
    ? desired.cohort.runtime.runtimeClosureDigest
    : desired.cohort.runtime.runtimeClosure.digest;
  let runtimeClosureDigest: `sha256:${string}` | undefined;
  assertQualifiedPnpmLockfileTargets(bytes, {
    targets: entries.map(
      ({ name, version, integrity, direct }) => ({ name, version, integrity, direct })
    ),
    internalEdges: QUALIFIED_DOCS_COHORT_V2_EDGES,
    forbiddenAliasTargetPackageNames: entries.map(({ name }) => name),
    runtimeClosureDigest: expectedRuntimeClosureDigest,
    enforceRuntimeClosureDigest,
    computeRuntimeClosureDigest(lockfile) {
      runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(
        lockfile,
        desired.cohort as unknown as QualifiedDocsCohortBindingV2
      );
      return runtimeClosureDigest;
    }
  });
  if (runtimeClosureDigest === undefined) {
    throw new Error("Qualified pnpm lockfile validation did not observe a runtime closure.");
  }
  return runtimeClosureDigest;
}

export function observeQualifiedPnpmLockfileV2(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile
): `sha256:${string}` {
  return validateQualifiedPnpmLockfileV2(bytes, desired, false);
}

export function assertQualifiedPnpmLockfileV2(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile
): void {
  validateQualifiedPnpmLockfileV2(bytes, desired, true);
}
