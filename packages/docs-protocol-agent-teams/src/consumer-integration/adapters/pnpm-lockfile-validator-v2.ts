import type { ConsumerIntegrationDesiredStateV3 } from "../domain/model.js";
import { qualifiedDocsCohortV2PackageEntries } from
  "../application/policies/qualified-docs-cohort-v2.js";
import { assertQualifiedPnpmLockfileTargets } from "./pnpm-lockfile-validator-v1.js";
import { computePnpmRuntimeClosureDigestV2 } from "./pnpm-runtime-closure-v2.js";

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

export function assertQualifiedPnpmLockfileV2(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV3
): void {
  const entries = qualifiedDocsCohortV2PackageEntries(desired.cohort);
  assertQualifiedPnpmLockfileTargets(bytes, {
    targets: entries.map(
      ({ name, version, integrity, direct }) => ({ name, version, integrity, direct })
    ),
    internalEdges: INTERNAL_EDGES,
    forbiddenAliasTargetPackageNames: entries.map(({ name }) => name),
    runtimeClosureDigest: desired.cohort.runtime.runtimeClosureDigest,
    computeRuntimeClosureDigest: (lockfile) =>
      computePnpmRuntimeClosureDigestV2(lockfile, desired.cohort)
  });
}
