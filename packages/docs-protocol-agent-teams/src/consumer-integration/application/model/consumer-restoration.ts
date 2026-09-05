import type { ConsumerUpgradeExecutionV1 } from "./consumer-upgrade-execution.js";
import type {
  KnownFileTransactionPlanV1, KnownFileTransactionReceiptV1,
  RepositoryMutationArtifactIdentity
} from "@agent-teams/repository-mutation";
import type {
  ConsumerIntegrationDesiredStateV1, ConsumerIntegrationIssue, QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../../domain/model.js";

export interface ConsumerRestorationProof {
  readonly schemaVersion: 1;
  readonly protocol: "agent-teams.managed-v1-restoration/v1";
  readonly sourceGeneration: 1;
  readonly targetGeneration: 2;
  readonly consumer: {
    readonly root: string;
    readonly device: string;
    readonly inode: string;
    readonly birthtimeNs: string;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  };
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly sourceInventoryDigest: `sha256:${string}`;
  readonly sourceCohort: QualifiedDocsCohortBindingV1;
  readonly targetCohort: QualifiedDocsCohortBindingV2;
  readonly controller: RepositoryMutationArtifactIdentity;
  readonly kernel: RepositoryMutationArtifactIdentity;
  readonly plan: KnownFileTransactionPlanV1;
  readonly receipt: KnownFileTransactionReceiptV1;
  readonly activation: "verified-current-v2";
}

export interface RetainedConsumerRestoration {
  readonly path: string;
  readonly digest: `sha256:${string}`;
}

export interface ConsumerRestorationOptions {
  readonly consumerRoot: string;
  readonly sourceGeneration: 2;
  readonly targetGeneration: 1;
  readonly from: string;
  readonly to: string;
  readonly proofPath: string;
  readonly expect: string;
  readonly activationOnly?: boolean;
}

export interface ConsumerRestorationExecution {
  readonly schemaVersion: 1;
  readonly command: "consumer.restore";
  readonly outcome: "blocked" | "restored" | "activated-v1";
  readonly issues: readonly ConsumerIntegrationIssue[];
  readonly proofDigest?: string;
  readonly inversePlanDigest?: string;
  readonly receipt?: KnownFileTransactionReceiptV1;
}

// The existing public upgrade API stays unchanged; retained proof is an explicit CLI lifecycle.
export interface RestorableConsumerUpgradeExecution extends ConsumerUpgradeExecutionV1 {
  readonly restoration?: RetainedConsumerRestoration;
}
