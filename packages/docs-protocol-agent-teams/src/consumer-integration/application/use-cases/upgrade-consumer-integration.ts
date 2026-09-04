import {
  compileKnownFileTransactionPlan,
  type KnownFileTransactionOperationInput,
  type KnownFileTransactionReceiptV1
} from "@agent-teams/repository-mutation";

import type {
  ConsumerUpgradeAuthority,
  ConsumerUpgradeAuthorityReader,
  ConsumerUpgradeManagedPreimagesV2,
  PreparedConsumerUpgradeV1,
  ConsumerUpgradeSandboxPort
} from "../ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationLifecyclePorts
} from "./run-consumer-integration.js";
import { compileConsumerIntegration } from "./plan-consumer-integration.js";
import type {
  ConsumerIntegrationIssue,
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2
} from "../../domain/model.js";
import type {
  ConsumerUpgradeExecutionV1
} from "../model/consumer-upgrade-execution.js";
import {
  canonicalConsumerIntegrationJson
} from "../policies/consumer-integration-assets.js";

export interface ConsumerUpgradePorts extends ConsumerIntegrationLifecyclePorts {
  readonly authority: ConsumerUpgradeAuthorityReader;
  readonly sandbox: ConsumerUpgradeSandboxPort;
}

function issue(code: string, subject: string, message: string): ConsumerIntegrationIssue {
  return Object.freeze({ code, severity: "error", subject, message });
}

function blocked(
  problem: ConsumerIntegrationIssue,
  authority?: ConsumerUpgradeAuthority
): ConsumerUpgradeExecutionV1 {
  return Object.freeze({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "blocked",
    issues: Object.freeze([problem]),
    ...(authority === undefined ? {} : { authority: authorityEvidence(authority) })
  });
}

function authorityEvidence(authority: ConsumerUpgradeAuthority) {
  return Object.freeze({
    repository: authority.repository,
    path: authority.path,
    revision: authority.revision,
    cohortId: authority.cohort.cohortId,
    recordDigest: authority.cohort.recordDigest,
    qualificationEventDigest: authority.cohort.qualificationEventDigest
  });
}

function incompatibleGeneration(
  current: ConsumerIntegrationDesiredState,
  authority: ConsumerUpgradeAuthority
): ConsumerIntegrationIssue {
  return issue(
    "DOCS_CONSUMER_COHORT_GENERATION_MISMATCH",
    authority.cohort.cohortId,
    `Profile schema ${current.schemaVersion} cannot upgrade to Cohort schema ${
      authority.cohort.schemaVersion
    }; only 1->1 and 3->2 are supported.`
  );
}

function isAuthorityV1(
  authority: ConsumerUpgradeAuthority
): authority is ConsumerUpgradeAuthorityV1 {
  return authority.cohort.schemaVersion === 1;
}

function isAuthorityV2(
  authority: ConsumerUpgradeAuthority
): authority is ConsumerUpgradeAuthorityV2 {
  return authority.cohort.schemaVersion === 2;
}

function reverseFullyOwnedOperations(
  operations: readonly KnownFileTransactionOperationInput[],
  receipt: KnownFileTransactionReceiptV1
): readonly KnownFileTransactionOperationInput[] {
  if (receipt.operations.length !== operations.length) {
    throw new TypeError("Upgrade receipt must classify every prepared operation exactly once.");
  }
  const receiptByPath = new Map(receipt.operations.map((operation) => [operation.path, operation]));
  if (receiptByPath.size !== operations.length ||
    operations.some((operation) => !receiptByPath.has(operation.path))) {
    throw new TypeError("Upgrade receipt paths must exactly match the prepared operation set.");
  }
  const reverseOperations = operations.flatMap((operation) => {
    if (operation.precondition.state !== "known-file" ||
      operation.precondition.acceptedPreimages.length !== 1) {
      throw new TypeError(
        "A Cohort-to-Cohort upgrade may replace only one exact existing preimage."
      );
    }
    const outcome = receiptByPath.get(operation.path)!.outcome;
    if (outcome === "already-satisfied") {return [];}
    if (outcome !== "replaced") {
      throw new TypeError(`Unexpected Cohort upgrade receipt outcome: ${outcome}.`);
    }
    const preimage = operation.precondition.acceptedPreimages[0]!;
    const postimageMode = operation.postimage.mode;
    if (postimageMode === undefined) {
      throw new TypeError("A Cohort-to-Cohort upgrade postimage must retain an exact file mode.");
    }
    return [Object.freeze({
      path: operation.path,
      precondition: {
        state: "known-file" as const,
        acceptedPreimages: [{ bytes: operation.postimage.bytes, mode: postimageMode }]
      },
      postimage: { bytes: preimage.bytes, mode: preimage.mode }
    })];
  });
  return reverseOperations.length === operations.length ? reverseOperations : [];
}

function managedPreimagesV2(
  current: Extract<ConsumerIntegrationDesiredState, { readonly schemaVersion: 3 }>,
  snapshot: ConsumerIntegrationSnapshot,
  plan: ConsumerIntegrationPlanV1
): ConsumerUpgradeManagedPreimagesV2 {
  function proof(
    id: "caller-workflow" | "managed-state" | "skill",
    observation: ConsumerIntegrationSnapshot["callerWorkflow"],
    path: string
  ) {
    const asset = plan.assets.find((candidate) => candidate.id === id);
    if (observation.state !== "file" || asset?.state !== "exact-current" ||
      asset.path !== path || asset.currentDigest === undefined) {
      throw new TypeError(`Current managed asset proof is unavailable: ${path}.`);
    }
    return Object.freeze({ digest: asset.currentDigest, mode: observation.mode, path });
  }
  return Object.freeze({
    callerWorkflow: proof("caller-workflow", snapshot.callerWorkflow, current.callerWorkflowPath),
    managedState: proof("managed-state", snapshot.managedState, current.managedStatePath),
    skill: proof("skill", snapshot.skill, current.skillPath)
  });
}

async function rollbackReceiptOwnedReplacements(
  consumerRoot: string,
  operations: readonly KnownFileTransactionOperationInput[],
  receipt: KnownFileTransactionReceiptV1,
  restoreAndVerify: () => Promise<void>,
  transaction: ConsumerIntegrationLifecyclePorts["transaction"]
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

export function createConsumerUpgradeUseCase(ports: ConsumerUpgradePorts) {
  // oxlint-disable-next-line complexity
  return async function upgrade(options: {
    readonly consumerRoot: string;
    readonly authorityRevision?: string;
    readonly to: string;
  }): Promise<ConsumerUpgradeExecutionV1> {
    const inspection = await ports.transaction.inspect({ consumerRoot: options.consumerRoot });
    if (inspection.state !== "idle") {
      return blocked(issue(inspection.code, "foundation-transaction", inspection.message));
    }
    const input = await ports.input.read({ consumerRoot: options.consumerRoot });
    const source = input.desired.schemaVersion === 1
      ? compileConsumerIntegration({
          desired: input.desired,
          snapshot: input.snapshot,
          assetCatalog: await ports.assets.read()
        }, ports.planning).plan
      : compileConsumerIntegration({
          desired: input.desired,
          snapshot: input.snapshot
        }, ports.planning).plan;
    if (source.outcome !== "current") {
      return blocked(issue(
        "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
        input.desired.cohort.cohortId,
        "The installed source Cohort must pass consumer check before a successor is staged."
      ));
    }
    if (input.desired.cohort.cohortId === options.to) {
      return Object.freeze({
        schemaVersion: 1,
        command: "consumer.upgrade",
        outcome: "current",
        issues: Object.freeze([])
      });
    }
    if (input.repositoryHead === undefined) {
      return blocked(issue(
        "DOCS_CONSUMER_UPGRADE_GIT_INVALID",
        input.root,
        "Cohort upgrade requires one exact committed source Git HEAD."
      ));
    }
    const authority = await ports.authority.read({
      cohortId: options.to,
      repository: input.desired.repository,
      ...(options.authorityRevision === undefined
        ? {}
        : { revision: options.authorityRevision })
    });
    const supportedGeneration =
      (input.desired.schemaVersion === 1 && isAuthorityV1(authority)) ||
      (input.desired.schemaVersion === 3 && isAuthorityV2(authority));
    if (!supportedGeneration) {
      return blocked(incompatibleGeneration(input.desired, authority), authority);
    }
    const transitionAllowed = authority.cohort.upgradeFrom.includes(
      input.desired.cohort.cohortId
    ) || input.desired.cohort.rollbackTo.includes(authority.cohort.cohortId);
    if (!transitionAllowed) {
      return blocked(issue(
        "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
        options.to,
        `Central authority does not permit a transition from ${input.desired.cohort.cohortId}.`
      ), authority);
    }
    let prepared: PreparedConsumerUpgradeV1;
    let activateAndVerify: () => Promise<void>;
    let restoreAndVerify: () => Promise<void>;
    if (input.desired.schemaVersion === 1 && isAuthorityV1(authority)) {
      const current = input.desired;
      prepared = await ports.sandbox.prepareV1({
        authority,
        consumerRoot: input.root,
        current,
        expectedSourceRevision: input.repositoryHead,
        expectedSourceSnapshot: input.snapshot
      });
      activateAndVerify = () => ports.sandbox.activateAndVerifyV1({
        authority,
        consumerRoot: input.root
      });
      restoreAndVerify = () => ports.sandbox.restoreAndVerifyV1({
        consumerRoot: input.root,
        current
      });
    } else if (input.desired.schemaVersion === 3 && isAuthorityV2(authority)) {
      const current = input.desired;
      prepared = await ports.sandbox.prepareV2({
        authority,
        consumerRoot: input.root,
        current,
        expectedSourceRevision: input.repositoryHead,
        expectedSourceSnapshot: input.snapshot,
        managedPreimages: managedPreimagesV2(current, input.snapshot, source)
      });
      activateAndVerify = () => ports.sandbox.activateAndVerifyV2({
        authority,
        consumerRoot: input.root
      });
      restoreAndVerify = () => ports.sandbox.restoreAndVerifyV2({
        consumerRoot: input.root,
        current
      });
    } else {
      return blocked(incompatibleGeneration(input.desired, authority), authority);
    }
    if (prepared.operations.length === 0) {
      throw new TypeError("The staged successor produced no repository changes.");
    }
    const confirmedAuthority = await ports.authority.read({
      cohortId: options.to,
      repository: input.desired.repository,
      revision: authority.revision
    });
    if (canonicalConsumerIntegrationJson(confirmedAuthority) !==
      canonicalConsumerIntegrationJson(authority)) {
      return blocked(issue(
        "DOCS_CONSUMER_AUTHORITY_CHANGED",
        options.to,
        "Central Cohort authority changed while the successor was staged."
      ), confirmedAuthority);
    }
    const mutationPlan = compileKnownFileTransactionPlan({
      operations: prepared.operations
    });
    const receipt = await ports.transaction.apply({
      consumerRoot: input.root,
      plan: mutationPlan
    });
    if (receipt.planDigest !== mutationPlan.planDigest) {
      throw new TypeError("Upgrade receipt does not bind the exact submitted mutation plan.");
    }
    try {
      await activateAndVerify();
    } catch (activationError) {
      await rollbackReceiptOwnedReplacements(input.root, prepared.operations, receipt, restoreAndVerify, ports.transaction);
      throw activationError;
    }
    return Object.freeze({
      schemaVersion: 1,
      command: "consumer.upgrade",
      outcome: receipt.outcome === "applied" ? "upgraded" : "current",
      issues: Object.freeze([]),
      authority: authorityEvidence(authority),
      receipt
    });
  };
}
