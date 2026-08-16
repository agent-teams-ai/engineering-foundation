import type {
  KnownFileTransactionPlanV1
} from "@agent-teams/engineering-foundation/mutation";

export type ConsumerIntegrationDigest = `sha256:${string}`;

export interface QualifiedDocsCohortV1 {
  readonly schemaVersion: 1;
  readonly cohortId: string;
  readonly channel: "rc" | "stable";
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
  };
  readonly schemas: {
    readonly consumerIntegration: 1;
    readonly managedState: 1;
    readonly docsProtocol: 1;
  };
  readonly runtime: {
    readonly node: ">=24.18.0 <25";
    readonly pnpm: ">=11.17.0 <12";
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
  readonly cohort: QualifiedDocsCohortV1;
}

export type ConsumerIntegrationFileObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "file";
      readonly bytes: Uint8Array;
      readonly mode: number;
    };

export interface ConsumerIntegrationSnapshot {
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
  readonly mutationPlan?: KnownFileTransactionPlanV1;
}

export interface KnownPriorConsumerAssets {
  readonly skill?: readonly Uint8Array[];
  readonly callerWorkflow?: readonly Uint8Array[];
  readonly agentsRoute?: readonly Uint8Array[];
}
