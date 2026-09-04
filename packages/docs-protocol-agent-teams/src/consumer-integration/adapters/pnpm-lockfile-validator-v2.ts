import type { ConsumerIntegrationDesiredStateV3 } from "../domain/model.js";
import { qualifiedDocsCohortV2PackageEntries } from
  "../application/policies/qualified-docs-cohort-v2.js";
import { assertQualifiedPnpmLockfileTargets } from "./pnpm-lockfile-validator-v1.js";
import { computePnpmRuntimeClosureDigestV2 } from "./pnpm-runtime-closure-v2.js";

const MAXIMUM_LOCKFILE_BYTES = 32 * 1024 * 1024;

const INTERNAL_EDGES = Object.freeze([
  Object.freeze({
    from: "@agent-teams/document-authoring",
    to: "@agent-teams/repository-mutation"
  }),
  Object.freeze({
    from: "@agent-teams/docs-protocol",
    to: "@agent-teams/document-authoring"
  }),
  Object.freeze({
    from: "@agent-teams/docs-protocol",
    to: "@agent-teams/repository-mutation"
  }),
  Object.freeze({
    from: "@agent-teams/docs-protocol-agent-teams",
    to: "@agent-teams/docs-protocol"
  }),
  Object.freeze({
    from: "@agent-teams/docs-protocol-agent-teams",
    to: "@agent-teams/repository-mutation"
  }),
  Object.freeze({
    from: "@agent-teams/engineering-foundation",
    to: "@agent-teams/document-authoring"
  }),
  Object.freeze({
    from: "@agent-teams/engineering-foundation",
    to: "@agent-teams/repository-mutation"
  })
]);

function validateQualifiedPnpmLockfileV2(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV3,
  enforceRuntimeClosureDigest: boolean
): `sha256:${string}` {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_LOCKFILE_BYTES) {
    throw new TypeError(
      `Qualification v3 lockfile must contain 1..${MAXIMUM_LOCKFILE_BYTES} bytes.`
    );
  }
  const entries = qualifiedDocsCohortV2PackageEntries(desired.cohort);
  let runtimeClosureDigest: `sha256:${string}` | undefined;
  assertQualifiedPnpmLockfileTargets(bytes, {
    targets: entries.map(
      ({ name, version, integrity, direct }) => ({ name, version, integrity, direct })
    ),
    internalEdges: INTERNAL_EDGES,
    forbiddenAliasTargetPackageNames: entries.map(({ name }) => name),
    runtimeClosureDigest: desired.cohort.runtime.runtimeClosureDigest,
    enforceRuntimeClosureDigest,
    computeRuntimeClosureDigest(lockfile) {
      runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(lockfile, desired.cohort);
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
  desired: ConsumerIntegrationDesiredStateV3
): `sha256:${string}` {
  return validateQualifiedPnpmLockfileV2(bytes, desired, false);
}

export function assertQualifiedPnpmLockfileV2(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV3
): void {
  validateQualifiedPnpmLockfileV2(bytes, desired, true);
}
