import { compileKnownFileTransactionPlan } from "@agent-teams/repository-mutation/known-file";
import {
  type ConsumerTargetLockfileInput,
  type ConsumerTargetLockfileReader,
  type ConsumerUpgradeAuthority,
  type PreparedConsumerUpgradeV1,
  type ConsumerUpgradeSandboxPort,
} from "../ports/consumer-upgrade.js";
import {
  type ConsumerIntegrationDesiredState,
  type ConsumerIntegrationPlanV1,
  type ConsumerIntegrationSnapshot,
  type ConsumerUpgradeAuthorityV1,
  type ConsumerUpgradeAuthorityV2,
} from "../../domain/model.js";
import { type RestorableConsumerUpgradeExecution } from "../model/consumer-restoration.js";
import { canonicalConsumerIntegrationJson } from "../policies/consumer-integration-assets.js";
import {
  type ConsumerUpgradePorts,
  issue,
  blocked,
  authorityEvidence,
  incompatibleGeneration,
  isAuthorityV1,
  isAuthorityV2,
  managedPreimagesV2,
  rollbackReceiptOwnedReplacements,
  prepareRestoration,
  type ConsumerUpgradeOptions,
  inspectUpgrade,
} from "./consumer-upgrade-inspection.js";
export type { ConsumerUpgradePorts } from "./consumer-upgrade-inspection.js";
function currentUpgrade(): RestorableConsumerUpgradeExecution {
  return Object.freeze({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "current",
    issues: Object.freeze([]),
  });
}

export function createConsumerUpgradeUseCase(ports: ConsumerUpgradePorts) {
  // oxlint-disable-next-line complexity
  return async function upgrade(
    options: ConsumerUpgradeOptions,
  ): Promise<RestorableConsumerUpgradeExecution> {
    const inspected = await inspectUpgrade(ports, options);
    if ("outcome" in inspected) {
      return inspected;
    }
    const { input, source, targetGeneration } = inspected;
    if (input.desired.cohort.cohortId === options.to) {
      if (input.desired.cohort.schemaVersion !== targetGeneration) {
        return blocked(
          issue(
            "DOCS_CONSUMER_COHORT_GENERATION_MISMATCH",
            options.to,
            "The explicit target generation does not match the installed Cohort generation.",
          ),
        );
      }
      return currentUpgrade();
    }
    if (input.repositoryHead === undefined) {
      return blocked(
        issue(
          "DOCS_CONSUMER_UPGRADE_GIT_INVALID",
          input.root,
          "Cohort upgrade requires one exact committed source Git HEAD.",
        ),
      );
    }
    const authority = await ports.authority.read({
      cohortId: options.to,
      generation: targetGeneration,
      repository: input.desired.repository,
      ...(options.authorityRevision === undefined ? {} : { revision: options.authorityRevision }),
    });
    if (authority.cohort.schemaVersion !== targetGeneration) {
      return blocked(incompatibleGeneration(input.desired, authority), authority);
    }
    const supportedGeneration =
      (input.desired.schemaVersion === 1 && isAuthorityV1(authority)) ||
      (input.desired.schemaVersion === 1 && isAuthorityV2(authority)) ||
      (input.desired.schemaVersion === 3 && isAuthorityV2(authority));
    if (!supportedGeneration) {
      return blocked(incompatibleGeneration(input.desired, authority), authority);
    }
    const crossGeneration = input.desired.schemaVersion === 1 && isAuthorityV2(authority);
    const transitionAllowed =
      authority.cohort.upgradeFrom.includes(input.desired.cohort.cohortId) ||
      (!crossGeneration && input.desired.cohort.rollbackTo.includes(authority.cohort.cohortId));
    if (!transitionAllowed) {
      return blocked(
        issue(
          "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
          options.to,
          `Central authority does not permit a transition from ${input.desired.cohort.cohortId}.`,
        ),
        authority,
      );
    }
    const targetLockfile = await readTargetLockfile(
      options.targetLockfile,
      ports.targetLockfile,
      input.root,
    );
    const transition = await prepareTransition({
      authority,
      current: input.desired,
      repositoryHead: input.repositoryHead,
      root: input.root,
      sandbox: ports.sandbox,
      ...(targetLockfile === undefined ? {} : { targetLockfile }),
      snapshot: input.snapshot,
      source,
    });
    if (transition === undefined) {
      return blocked(incompatibleGeneration(input.desired, authority), authority);
    }
    const { activateAndVerify, prepared, restoreAndVerify } = transition;
    if (prepared.operations.length === 0) {
      throw new TypeError("The staged successor produced no repository changes.");
    }
    const confirmedAuthority = await ports.authority.read({
      cohortId: options.to,
      generation: targetGeneration,
      repository: input.desired.repository,
      revision: authority.revision,
    });
    if (
      canonicalConsumerIntegrationJson(confirmedAuthority) !==
      canonicalConsumerIntegrationJson(authority)
    ) {
      return blocked(
        issue(
          "DOCS_CONSUMER_AUTHORITY_CHANGED",
          options.to,
          "Central Cohort authority changed while the successor was staged.",
        ),
        confirmedAuthority,
      );
    }
    const mutationPlan = compileKnownFileTransactionPlan({ operations: prepared.operations });
    const restoration = await prepareRestoration(
      ports.restoration,
      options.restorationProofPath,
      input,
      authority,
      mutationPlan,
    );
    if (restoration !== undefined) {
      return {
        schemaVersion: 1,
        command: "consumer.upgrade",
        outcome: "prepared",
        issues: [],
        preparation: restoration,
      };
    }
    const receipt = await ports.transaction.apply({
      consumerRoot: input.root,
      plan: mutationPlan,
    });
    if (receipt.planDigest !== mutationPlan.planDigest) {
      throw new TypeError("Upgrade receipt does not bind the exact submitted mutation plan.");
    }
    try {
      await activateAndVerify();
    } catch (activationError) {
      await rollbackReceiptOwnedReplacements(
        input.root,
        prepared.operations,
        receipt,
        restoreAndVerify,
        ports.transaction,
      );
      throw activationError;
    }
    return Object.freeze({
      schemaVersion: 1,
      command: "consumer.upgrade",
      outcome: receipt.outcome === "applied" ? "upgraded" : "current",
      issues: Object.freeze([]),
      authority: authorityEvidence(authority),
      receipt,
    });
  };
}

async function prepareTransition(input: {
  readonly targetLockfile?: Uint8Array;
  readonly authority: ConsumerUpgradeAuthority;
  readonly current: ConsumerIntegrationDesiredState;
  readonly repositoryHead: string;
  readonly root: string;
  readonly sandbox: ConsumerUpgradeSandboxPort;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly source: ConsumerIntegrationPlanV1;
}): Promise<
  | {
      readonly activateAndVerify: () => Promise<void>;
      readonly prepared: PreparedConsumerUpgradeV1;
      readonly restoreAndVerify: () => Promise<void>;
    }
  | undefined
> {
  const common = {
    consumerRoot: input.root,
    expectedSourceRevision: input.repositoryHead,
    expectedSourceSnapshot: input.snapshot,
  };
  if (input.current.schemaVersion === 1 && isAuthorityV1(input.authority)) {
    return {
      prepared: await input.sandbox.prepareV1({
        ...common,
        authority: input.authority,
        current: input.current,
      }),
      activateAndVerify: () =>
        input.sandbox.activateAndVerifyV1({
          authority: input.authority as ConsumerUpgradeAuthorityV1,
          consumerRoot: input.root,
        }),
      restoreAndVerify: () =>
        input.sandbox.restoreAndVerifyV1({
          consumerRoot: input.root,
          current: input.current as Extract<ConsumerIntegrationDesiredState, { schemaVersion: 1 }>,
        }),
    };
  }
  if (input.current.schemaVersion === 3 && isAuthorityV2(input.authority)) {
    return {
      prepared: await input.sandbox.prepareV2({
        ...common,
        authority: input.authority,
        current: input.current,
        managedPreimages: managedPreimagesV2(input.current, input.snapshot, input.source),
      }),
      activateAndVerify: () =>
        input.sandbox.activateAndVerifyV2({
          authority: input.authority as ConsumerUpgradeAuthorityV2,
          consumerRoot: input.root,
        }),
      restoreAndVerify: () =>
        input.sandbox.restoreAndVerifyV2({
          consumerRoot: input.root,
          current: input.current as Extract<ConsumerIntegrationDesiredState, { schemaVersion: 3 }>,
        }),
    };
  }
  if (input.current.schemaVersion === 1 && isAuthorityV2(input.authority)) {
    return {
      prepared: await input.sandbox.prepareV1ToV2({
        ...(input.targetLockfile === undefined ? {} : { targetLockfile: input.targetLockfile }),
        ...common,
        authority: input.authority,
        current: input.current,
      }),
      activateAndVerify: () =>
        input.sandbox.activateAndVerifyV2({
          authority: input.authority as ConsumerUpgradeAuthorityV2,
          consumerRoot: input.root,
        }),
      restoreAndVerify: () =>
        input.sandbox.restoreAndVerifyV1({
          consumerRoot: input.root,
          current: input.current as Extract<ConsumerIntegrationDesiredState, { schemaVersion: 1 }>,
        }),
    };
  }
  return undefined;
}

async function readTargetLockfile(
  input: ConsumerTargetLockfileInput | undefined,
  reader: ConsumerTargetLockfileReader | undefined,
  root: string,
): Promise<Uint8Array | undefined> {
  if (input === undefined) {
    return undefined;
  }
  if (reader === undefined) {
    throw new TypeError("Target lock preparation requires its input reader.");
  }
  return reader.read(input, root);
}
