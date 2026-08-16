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
