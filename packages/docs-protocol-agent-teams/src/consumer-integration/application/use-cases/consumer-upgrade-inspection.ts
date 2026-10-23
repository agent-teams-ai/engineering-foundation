import {
  compileKnownFileTransactionPlan,
  type KnownFileTransactionOperationInput,
  type KnownFileTransactionReceiptV1,
} from "@agent-teams/repository-mutation/known-file";
import {
  type ConsumerTargetLockfileInput,
  type ConsumerTargetLockfileReader,
  type ConsumerUpgradeAuthority,
  type ConsumerUpgradeAuthorityReader,
  type ConsumerUpgradeManagedPreimagesV2,
  type ConsumerUpgradeSandboxPort,
} from "../ports/consumer-upgrade.js";
import { type ConsumerIntegrationLifecyclePorts } from "./run-consumer-integration.js";
import { compileConsumerIntegration } from "./plan-consumer-integration.js";
import {
  type ConsumerIntegrationIssue,
  type ConsumerIntegrationDesiredState,
  type ConsumerIntegrationPlanV1,
  type ConsumerIntegrationSnapshot,
  type ConsumerUpgradeAuthorityV1,
  type ConsumerUpgradeAuthorityV2,
} from "../../domain/model.js";
import { type RestorableConsumerUpgradeExecution } from "../model/consumer-restoration.js";
import { type ConsumerRestorationRecorder } from "../ports/consumer-restoration.js";
export interface ConsumerUpgradePorts extends ConsumerIntegrationLifecyclePorts {
  readonly targetLockfile?: ConsumerTargetLockfileReader;
  readonly authority: ConsumerUpgradeAuthorityReader;
  readonly restoration?: ConsumerRestorationRecorder;
  readonly sandbox: ConsumerUpgradeSandboxPort;
}

export function issue(code: string, subject: string, message: string): ConsumerIntegrationIssue {
  return Object.freeze({ code, severity: "error", subject, message });
}

export function blocked(
  problem: ConsumerIntegrationIssue,
  authority?: ConsumerUpgradeAuthority,
): RestorableConsumerUpgradeExecution {
  return Object.freeze({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "blocked",
    issues: Object.freeze([problem]),
    ...(authority === undefined ? {} : { authority: authorityEvidence(authority) }),
  });
}

export function authorityEvidence(authority: ConsumerUpgradeAuthority) {
  return Object.freeze({
    repository: authority.repository,
    path: authority.path,
    revision: authority.revision,
    cohortId: authority.cohort.cohortId,
    recordDigest: authority.cohort.recordDigest,
    qualificationEventDigest: authority.cohort.qualificationEventDigest,
  });
}

export function incompatibleGeneration(
  current: ConsumerIntegrationDesiredState,
  authority: ConsumerUpgradeAuthority,
): ConsumerIntegrationIssue {
  return issue(
    "DOCS_CONSUMER_COHORT_GENERATION_MISMATCH",
    authority.cohort.cohortId,
    `Profile schema ${current.schemaVersion} cannot upgrade to Cohort schema ${
      authority.cohort.schemaVersion
    }; only 1->1, explicit 1->2 migration, and 3->2 are supported.`,
  );
}

export function isAuthorityV1(
  authority: ConsumerUpgradeAuthority,
): authority is ConsumerUpgradeAuthorityV1 {
  return authority.cohort.schemaVersion === 1;
}

export function isAuthorityV2(
  authority: ConsumerUpgradeAuthority,
): authority is ConsumerUpgradeAuthorityV2 {
  return authority.cohort.schemaVersion === 2;
}

function reverseFullyOwnedOperations(
  operations: readonly KnownFileTransactionOperationInput[],
  receipt: KnownFileTransactionReceiptV1,
): readonly KnownFileTransactionOperationInput[] {
  if (receipt.operations.length !== operations.length) {
    throw new TypeError("Upgrade receipt must classify every prepared operation exactly once.");
  }
  const receiptByPath = new Map(receipt.operations.map((operation) => [operation.path, operation]));
  if (
    receiptByPath.size !== operations.length ||
    operations.some((operation) => !receiptByPath.has(operation.path))
  ) {
    throw new TypeError("Upgrade receipt paths must exactly match the prepared operation set.");
  }
  const reverseOperations = operations.flatMap((operation) => {
    if (
      operation.precondition.state !== "known-file" ||
      operation.precondition.acceptedPreimages.length !== 1
    ) {
      throw new TypeError(
        "A Cohort-to-Cohort upgrade may replace only one exact existing preimage.",
      );
    }
    const outcome = receiptByPath.get(operation.path)!.outcome;
    if (outcome === "already-satisfied") {
      return [];
    }
    if (outcome !== "replaced") {
      throw new TypeError(`Unexpected Cohort upgrade receipt outcome: ${outcome}.`);
    }
    const preimage = operation.precondition.acceptedPreimages[0]!;
    const postimageMode = operation.postimage.mode;
    if (postimageMode === undefined) {
      throw new TypeError("A Cohort-to-Cohort upgrade postimage must retain an exact file mode.");
    }
    return [
      Object.freeze({
        path: operation.path,
        precondition: {
          state: "known-file" as const,
          acceptedPreimages: [{ bytes: operation.postimage.bytes, mode: postimageMode }],
        },
        postimage: { bytes: preimage.bytes, mode: preimage.mode },
      }),
    ];
  });
  return reverseOperations.length === operations.length ? reverseOperations : [];
}

export function managedPreimagesV2(
  current: Extract<ConsumerIntegrationDesiredState, { readonly schemaVersion: 3 }>,
  snapshot: ConsumerIntegrationSnapshot,
  plan: ConsumerIntegrationPlanV1,
): ConsumerUpgradeManagedPreimagesV2 {
  function proof(
    id: "caller-workflow" | "managed-state" | "skill",
    observation: ConsumerIntegrationSnapshot["callerWorkflow"],
    path: string,
  ) {
    const asset = plan.assets.find((candidate) => candidate.id === id);
    if (
      observation.state !== "file" ||
      asset?.state !== "exact-current" ||
      asset.path !== path ||
      asset.currentDigest === undefined
    ) {
      throw new TypeError(`Current managed asset proof is unavailable: ${path}.`);
    }
    return Object.freeze({ digest: asset.currentDigest, mode: observation.mode, path });
  }
  return Object.freeze({
    callerWorkflow: proof("caller-workflow", snapshot.callerWorkflow, current.callerWorkflowPath),
    managedState: proof("managed-state", snapshot.managedState, current.managedStatePath),
    skill: proof("skill", snapshot.skill, current.skillPath),
  });
}

export async function rollbackReceiptOwnedReplacements(
  consumerRoot: string,
  operations: readonly KnownFileTransactionOperationInput[],
  receipt: KnownFileTransactionReceiptV1,
  restoreAndVerify: () => Promise<void>,
  transaction: ConsumerIntegrationLifecyclePorts["transaction"],
): Promise<void> {
  const rollbackOperations = reverseFullyOwnedOperations(operations, receipt);
  if (rollbackOperations.length > 0) {
    const rollbackPlan = compileKnownFileTransactionPlan({ operations: rollbackOperations });
    await transaction.apply({ consumerRoot, plan: rollbackPlan });
  }
  if (rollbackOperations.length === operations.length) {
    await restoreAndVerify();
  }
}

function restorationOptionIssue(
  options: {
    readonly targetLockfile?: ConsumerTargetLockfileInput;
    readonly prepare?: boolean;
    readonly restorationProofPath?: string;
    readonly sourceGeneration?: 1;
    readonly targetGeneration?: 1 | 2;
    readonly to: string;
  },
  desired: ConsumerIntegrationDesiredState,
  recorder: ConsumerRestorationRecorder | undefined,
): RestorableConsumerUpgradeExecution | undefined {
  if (
    options.targetLockfile !== undefined &&
    (options.prepare !== true ||
      options.sourceGeneration !== 1 ||
      options.targetGeneration !== 2 ||
      options.restorationProofPath === undefined ||
      !/^sha256:[a-f0-9]{64}$/.test(options.targetLockfile.sha256))
  ) {
    return blocked(
      issue(
        "DOCS_CONSUMER_TARGET_LOCK_INVALID",
        options.to,
        "Target lock requires its SHA256 and explicit 1->2 preparation with restoration proof.",
      ),
    );
  }
  if (
    options.restorationProofPath !== undefined &&
    (options.prepare !== true ||
      options.sourceGeneration !== 1 ||
      options.targetGeneration !== 2 ||
      desired.schemaVersion !== 1 ||
      recorder === undefined)
  ) {
    return blocked(
      issue(
        "DOCS_CONSUMER_RESTORATION_GENERATION_INVALID",
        options.to,
        "Retained restoration requires --prepare, explicit 1->2 migration and an external proof path.",
      ),
    );
  }
  if (
    (options.sourceGeneration !== undefined || options.prepare === true) &&
    options.restorationProofPath === undefined
  ) {
    return blocked(
      issue(
        "DOCS_CONSUMER_RESTORATION_PROOF_REQUIRED",
        options.to,
        "--source-generation requires --restoration-proof for the bounded migration.",
      ),
    );
  }
  return undefined;
}

export async function prepareRestoration(
  recorder: ConsumerRestorationRecorder | undefined,
  proofPath: string | undefined,
  input: {
    readonly root: string;
    readonly repositoryHead?: string;
    readonly desired: ConsumerIntegrationDesiredState;
  },
  authority: ConsumerUpgradeAuthority,
  plan: ReturnType<typeof compileKnownFileTransactionPlan>,
) {
  return proofPath !== undefined && input.desired.schemaVersion === 1 && isAuthorityV2(authority)
    ? recorder!.prepare({
        consumerRoot: input.root,
        sourceRevision: input.repositoryHead!,
        current: input.desired,
        target: authority.cohort,
        plan,
        proofPath,
      })
    : undefined;
}

export interface ConsumerUpgradeOptions {
  readonly targetLockfile?: ConsumerTargetLockfileInput;
  readonly consumerRoot: string;
  readonly authorityRevision?: string;
  readonly targetGeneration?: 1 | 2;
  readonly to: string;
  readonly sourceGeneration?: 1;
  readonly restorationProofPath?: string;
  readonly prepare?: boolean;
}

export async function inspectUpgrade(
  ports: ConsumerUpgradePorts,
  options: ConsumerUpgradeOptions,
): Promise<
  | RestorableConsumerUpgradeExecution
  | {
      input: Awaited<ReturnType<ConsumerUpgradePorts["input"]["read"]>>;
      source: ConsumerIntegrationPlanV1;
      targetGeneration: 1 | 2;
    }
> {
  if (options.targetGeneration !== 1 && options.targetGeneration !== 2) {
    return blocked(
      issue(
        "DOCS_CONSUMER_TARGET_GENERATION_REQUIRED",
        options.to,
        "Upgrade requires one explicit target Cohort generation (1 or 2).",
      ),
    );
  }
  const inspection = await ports.transaction.inspect({ consumerRoot: options.consumerRoot });
  if (inspection.state !== "idle") {
    return blocked(issue(inspection.code, "foundation-transaction", inspection.message));
  }
  const input = await ports.input.read({ consumerRoot: options.consumerRoot });
  const restorationIssue = restorationOptionIssue(options, input.desired, ports.restoration);
  if (restorationIssue !== undefined) {
    return restorationIssue;
  }
  const source = compileConsumerIntegration(
    {
      desired: input.desired,
      snapshot: input.snapshot,
      assetCatalog: await ports.assets.read(),
    },
    ports.planning,
  ).plan;
  if (source.outcome !== "current") {
    return blocked(
      issue(
        "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
        input.desired.cohort.cohortId,
        "The installed source Cohort must pass consumer check before a successor is staged.",
      ),
    );
  }
  return { input, source, targetGeneration: options.targetGeneration };
}
