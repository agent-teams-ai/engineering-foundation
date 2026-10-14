import type { UnselectedCohortV3 } from "../../domain/model.js";

export type { UnselectedCohortV3 } from "../../domain/model.js";

export interface PackedManagedRuntimePolicy {
  readonly policyId: "agent-teams.docs-protocol-current-policy";
  readonly policyVersion: "3.0.0";
  readonly sourceDigest: string;
  readonly pnpm: string;
  readonly lanes: Readonly<Record<"node-24-production-default" | "node-26-managed-qualified", {
    readonly node: string;
    readonly qualificationRuntime: UnselectedCohortV3["runtime"]["qualificationRuntime"];
    readonly default: boolean;
  }>>;
}

// Exact package coordinates use the Foundation exact-version grammar at this
// package's pure boundary; historical readers and their schemas remain frozen.
const EXACT_PACKAGE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/** Calendar validation for the UTC-second eligibility value shared by Cohort3 and Profile4. */
function isCanonicalUtcSecond(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) { return false; }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === `${value.slice(0, -1)}.000Z`;
}

function hasExactString(value: unknown, expected: string): boolean {
  return typeof value === "string" && value === expected;
}

export function bindUnselectedCohortV3(
  candidate: UnselectedCohortV3,
  policy: PackedManagedRuntimePolicy
): UnselectedCohortV3 {
  const runtime = candidate.runtime;
  const lane = policy.lanes[runtime.selectedLane];
  if (Object.values(candidate.packages).some(({ version }) => !EXACT_PACKAGE_VERSION.test(version))) {
    throw new TypeError("Cohort v3 package coordinates require exact semantic versions.");
  }
  if (!isCanonicalUtcSecond(candidate.eligibleAfter)) {
    throw new TypeError("Cohort v3 eligibleAfter must be a real canonical UTC-second timestamp.");
  }
  if (candidate.upgradeFrom.length === 0 || candidate.rollbackTo.length === 0 ||
      candidate.upgradeFrom.includes(candidate.cohortId) ||
      candidate.rollbackTo.includes(candidate.cohortId) ||
      candidate.rollbackTo.some((origin) => !candidate.upgradeFrom.includes(origin))) {
    throw new TypeError("Cohort v3 source and rollback edges are inconsistent.");
  }
  if (!hasExactString(runtime.policy.id, policy.policyId) ||
      !hasExactString(runtime.policy.version, policy.policyVersion) ||
      runtime.policy.digest !== policy.sourceDigest || !Object.hasOwn(policy.lanes, runtime.selectedLane) ||
      runtime.node !== lane.node || runtime.pnpm !== policy.pnpm ||
      runtime.qualificationRuntime.nodeVersion !== lane.qualificationRuntime.nodeVersion ||
      runtime.qualificationRuntime.pnpmVersion !== lane.qualificationRuntime.pnpmVersion ||
      runtime.qualificationRuntime.platform !== lane.qualificationRuntime.platform ||
      runtime.qualificationRuntime.architecture !== lane.qualificationRuntime.architecture ||
      policy.lanes["node-24-production-default"].default ||
      !policy.lanes["node-26-managed-qualified"].default) {
    throw new TypeError("Cohort v3 runtime differs from the packed managed policy lane.");
  }
  return candidate;
}
