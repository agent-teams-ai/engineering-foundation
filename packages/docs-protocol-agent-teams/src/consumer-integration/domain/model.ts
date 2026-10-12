export type ConsumerIntegrationDigest = `sha256:${string}`;

export interface QualifiedDocsCohortV1 {
  readonly schemaVersion: 1;
  readonly cohortId: string;
  readonly channel: "rc" | "stable";
  readonly recordDigest: ConsumerIntegrationDigest;
  readonly qualificationEventDigest: ConsumerIntegrationDigest;
  readonly lifecycleState: "QUALIFIED" | "CANARY" | "RECOMMENDED";
  readonly eligibleAfter: string;
  readonly upgradeFrom: readonly string[];
  readonly rollbackTo: readonly string[];
  readonly canaryRepositoryIds: readonly string[];
  readonly packages: {
    readonly docsProtocol: {
      readonly version: string;
      readonly integrity: `sha512-${string}`;
    };
    readonly engineeringFoundation: {
      readonly version: string;
      readonly integrity: `sha512-${string}`;
    };
  };
  readonly workflow: {
    readonly repository: string;
    readonly path: string;
    readonly revision: string;
    readonly blobSha: string;
  };
  readonly assets: {
    readonly skillDigest: ConsumerIntegrationDigest;
    readonly callerWorkflowDigest: ConsumerIntegrationDigest;
    readonly assetCatalogDigest: ConsumerIntegrationDigest;
    readonly transitionCatalogDigest: ConsumerIntegrationDigest;
  };
  readonly schemas: {
    readonly consumerIntegration: 1;
    readonly managedState: 1;
    readonly docsProtocol: 1;
  };
  readonly runtime: {
    readonly node: ">=24.18.0 <25";
    readonly pnpm: ">=11.17.0 <12";
    readonly runtimeClosureDigest: ConsumerIntegrationDigest;
  };
}

/** Immutable Cohort evidence that may be committed in a consumer repository. */
export type QualifiedDocsCohortBindingV1 = Omit<
  QualifiedDocsCohortV1,
  "canaryRepositoryIds" | "lifecycleState"
>;

export interface QualifiedDocsPackageCoordinateV2 {
  readonly version: string;
  readonly integrity: `sha512-${string}`;
}

/**
 * Closed managed-documentation release set. The five coordinates are explicit so
 * consumers never infer a Cohort generation from whichever packages happen to be
 * installed.
 */
export interface QualifiedDocsCohortV2 {
  readonly schemaVersion: 2;
  readonly cohortId: string;
  readonly channel: "rc" | "stable";
  readonly recordDigest: ConsumerIntegrationDigest;
  readonly qualificationEventDigest: ConsumerIntegrationDigest;
  readonly lifecycleState: "QUALIFIED" | "CANARY" | "RECOMMENDED";
  readonly eligibleAfter: string;
  readonly upgradeFrom: readonly string[];
  readonly rollbackTo: readonly string[];
  readonly canaryRepositoryIds: readonly string[];
  readonly packages: {
    readonly repositoryMutation: QualifiedDocsPackageCoordinateV2;
    readonly documentAuthoring: QualifiedDocsPackageCoordinateV2;
    readonly docsProtocol: QualifiedDocsPackageCoordinateV2;
    readonly docsProtocolAgentTeams: QualifiedDocsPackageCoordinateV2;
    readonly engineeringFoundation: QualifiedDocsPackageCoordinateV2;
  };
  readonly workflow: QualifiedDocsCohortV1["workflow"];
  readonly assets: QualifiedDocsCohortV1["assets"];
  readonly schemas: {
    readonly consumerIntegration: 3;
    readonly managedState: 2;
    readonly docsProtocol: 1;
  };
  readonly runtime: QualifiedDocsCohortV1["runtime"];
}

export type QualifiedDocsCohortBindingV2 = Omit<
  QualifiedDocsCohortV2,
  "canaryRepositoryIds" | "lifecycleState"
>;

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
  readonly lifecycleState: "QUALIFIED" | "CANARY" | "RECOMMENDED";
  readonly canaryRepositoryIds: readonly string[];
  readonly packages: Readonly<Record<"repositoryMutation" | "documentAuthoring" | "docsProtocol" |
    "docsProtocolAgentTeams" | "engineeringFoundation", { readonly version: string; readonly integrity: `sha512-${string}` }>>;
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
    readonly policy: { readonly id: "agent-teams.docs-protocol-current-policy"; readonly version: "3.0.0"; readonly digest: string };
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

export interface ConsumerIntegrationDesiredStateV1 {
  readonly schemaVersion: 1;
  readonly repository: {
    readonly provider: "github";
    readonly id: string;
    readonly nameWithOwner: string;
  };
  readonly integrationRoot: ".";
  readonly packageManager: "pnpm";
  readonly profilePath: string;
  readonly skillPath: string;
  readonly callerWorkflowPath: string;
  readonly managedStatePath: string;
  readonly governedDocsRoots?: readonly string[];
  readonly cohort: QualifiedDocsCohortBindingV1;
}

/** New-only managed profile. V1/V2 profiles remain immutable migration evidence. */
export interface ConsumerIntegrationDesiredStateV3 {
  readonly schemaVersion: 3;
  readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  readonly integrationRoot: ".";
  readonly packageManager: "pnpm";
  readonly profilePath: string;
  readonly skillPath: string;
  readonly callerWorkflowPath: string;
  readonly managedStatePath: string;
  readonly governedDocsRoots?: readonly string[];
  readonly qualification: {
    readonly contractPath: "architecture/foundation/docs-protocol-qualification.json";
    readonly gateCommand: "pnpm docs:protocol:check";
  };
  readonly cohort: QualifiedDocsCohortBindingV2;
}

/** Closed unselected Profile4 binding over Cohort3; it grants no lifecycle selection. */
export interface ManagedSuccessorProfile {
  readonly schemaVersion: 4;
  readonly repository: { readonly provider: "github"; readonly id: string; readonly nameWithOwner: string };
  readonly integrationRoot: ".";
  readonly packageManager: "pnpm";
  readonly profilePath: string;
  readonly skillPath: string;
  readonly callerWorkflowPath: string;
  readonly managedStatePath: string;
  readonly qualification: { readonly contractPath: string; readonly gateCommand: string };
  readonly governedDocsRoots?: readonly string[];
  readonly cohort: Omit<UnselectedCohortV3, "lifecycleState" | "canaryRepositoryIds">;
}

export interface ManagedSuccessorAssetDigests {
  readonly skillDigest: string;
  readonly callerWorkflowDigest: string;
  readonly assetCatalogDigest: string;
  readonly transitionCatalogDigest: string;
  readonly agentsRouteDigest: string;
  readonly docsScriptsDigest: string;
}

export type ConsumerIntegrationDesiredState =
  | ConsumerIntegrationDesiredStateV1
  | ConsumerIntegrationDesiredStateV3
  | ManagedSuccessorProfile;

export type ConsumerIntegrationFileObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "file";
      readonly bytes: Uint8Array;
      readonly mode: number;
    };

export interface ConsumerIntegrationSnapshot {
  readonly integrationProfile: ConsumerIntegrationFileObservation;
  readonly lockfile: ConsumerIntegrationFileObservation;
  readonly packageManifest: ConsumerIntegrationFileObservation;
  readonly agents: ConsumerIntegrationFileObservation;
  readonly skill: ConsumerIntegrationFileObservation;
  readonly callerWorkflow: ConsumerIntegrationFileObservation;
  readonly managedState: ConsumerIntegrationFileObservation;
}

export type ConsumerIntegrationAssetState =
  | "absent"
  | "exact-current"
  | "known-prior"
  | "partial-adoption"
  | "outdated-cohort"
  | "unknown-modified"
  | "conflict"
  | "unsupported";

export interface ConsumerIntegrationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly subject: string;
  readonly message: string;
}

export interface ConsumerIntegrationAssetPlan {
  readonly id:
    | "agents-route"
    | "caller-workflow"
    | "managed-state"
    | "package-manifest"
    | "skill";
  readonly path: string;
  readonly ownership: "full-bytes" | "partial-fields" | "managed-block";
  readonly state: ConsumerIntegrationAssetState;
  readonly currentDigest?: ConsumerIntegrationDigest;
  readonly expectedDigest: ConsumerIntegrationDigest;
  readonly action: "create" | "none" | "replace" | "blocked";
}

export interface ConsumerIntegrationPlanV1 {
  readonly schemaVersion: 1;
  readonly cohortId: string;
  readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  readonly planDigest: ConsumerIntegrationDigest;
  readonly outcome: "blocked" | "change-required" | "current";
  readonly assets: readonly ConsumerIntegrationAssetPlan[];
  readonly issues: readonly ConsumerIntegrationIssue[];
}

export interface ConsumerUpgradeAuthorityV1 {
  readonly repository: "agent-teams-ai/.github";
  readonly path: "governance/docs-qualified-cohorts.json";
  readonly revision: string;
  readonly cohort: QualifiedDocsCohortBindingV1;
}

export interface ConsumerUpgradeAuthorityV2 {
  readonly repository: "agent-teams-ai/.github";
  readonly path: "governance/docs-qualified-cohorts.json";
  readonly revision: string;
  readonly cohort: QualifiedDocsCohortBindingV2;
}
