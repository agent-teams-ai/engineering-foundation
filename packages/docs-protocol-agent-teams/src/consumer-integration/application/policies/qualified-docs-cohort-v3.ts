/** Candidate shape and lane consistency; validation grants no lifecycle selection. */
export interface UnselectedCohortV3 {
  readonly schemaVersion: 3;
  readonly cohortId: string;
  readonly channel: "rc" | "stable";
  readonly recordDigest: string;
  readonly qualificationEventDigest: string;
  readonly eligibleAfter: string;
  readonly upgradeFrom: readonly string[];
  readonly rollbackTo: readonly string[];
  readonly candidateDigest: string;
  readonly packages: Readonly<Record<"repositoryMutation" | "documentAuthoring" | "docsProtocol" |
    "docsProtocolAgentTeams" | "engineeringFoundation", { readonly version: string; readonly integrity: string }>>;
  readonly workflow: { readonly repository: "agent-teams-ai/.github"; readonly path: ".github/workflows/docs-protocol-check.yml";
    readonly revision: string; readonly blobSha: string };
  readonly assets: { readonly skillDigest: string; readonly callerWorkflowDigest: string;
    readonly assetCatalogDigest: string; readonly transitionCatalogDigest: string };
  readonly schemas: {
    readonly consumerIntegration: 4;
    readonly managedState: 3;
    readonly qualificationReceipt: 1;
    readonly docsProtocol: 1;
  };
  readonly runtime: {
    readonly policy: { readonly id: "agent-teams.docs-protocol-current-policy"; readonly version: "2.0.0"; readonly digest: string };
    readonly selectedLane: "node-24-production-default" | "node-26-managed-qualified";
    readonly node: string;
    readonly pnpm: string;
    readonly qualificationRuntime: {
      readonly nodeVersion: string;
      readonly pnpmVersion: string;
      readonly platform: string;
      readonly architecture: string;
    };
    readonly runtimeClosure: { readonly domain: "agent-teams.docs-runtime-closure/v2"; readonly digest: string };
  };
}

export interface PackedManagedRuntimePolicy {
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
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().replace(".000", "") === value;
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
  if (runtime.policy.digest !== policy.sourceDigest ||
      runtime.node !== lane.node || runtime.pnpm !== policy.pnpm ||
      runtime.qualificationRuntime.nodeVersion !== lane.qualificationRuntime.nodeVersion ||
      runtime.qualificationRuntime.pnpmVersion !== lane.qualificationRuntime.pnpmVersion ||
      runtime.qualificationRuntime.platform !== lane.qualificationRuntime.platform ||
      runtime.qualificationRuntime.architecture !== lane.qualificationRuntime.architecture ||
      !policy.lanes["node-24-production-default"].default ||
      policy.lanes["node-26-managed-qualified"].default) {
    throw new TypeError("Cohort v3 runtime differs from the packed managed policy lane.");
  }
  return candidate;
}
