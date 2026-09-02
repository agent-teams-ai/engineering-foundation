import {
  compileKnownFileTransactionPlan,
  type KnownFileTransactionOperationInput
} from "@agent-teams/repository-mutation";

import type {
  ConsumerUpgradeAuthorityReader,
  ConsumerUpgradeSandboxPort
} from "../ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationLifecyclePorts
} from "./run-consumer-integration.js";
import { compileConsumerIntegration } from "./plan-consumer-integration.js";
import type {
  ConsumerIntegrationIssue,
  ConsumerUpgradeAuthorityV1
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
  authority?: ConsumerUpgradeAuthorityV1
): ConsumerUpgradeExecutionV1 {
  return Object.freeze({
    schemaVersion: 1,
    command: "consumer.upgrade",
    outcome: "blocked",
    issues: Object.freeze([problem]),
    ...(authority === undefined ? {} : { authority: authorityEvidence(authority) })
  });
}

function authorityEvidence(authority: ConsumerUpgradeAuthorityV1) {
  return Object.freeze({
    repository: authority.repository,
    path: authority.path,
    revision: authority.revision,
    cohortId: authority.cohort.cohortId,
    recordDigest: authority.cohort.recordDigest,
    qualificationEventDigest: authority.cohort.qualificationEventDigest
  });
}

function reverseOperations(
  operations: readonly KnownFileTransactionOperationInput[]
): readonly KnownFileTransactionOperationInput[] {
  return operations.map((operation) => {
    if (operation.precondition.state !== "known-file" ||
      operation.precondition.acceptedPreimages.length !== 1) {
      throw new TypeError(
        "A Cohort-to-Cohort upgrade may replace only one exact existing preimage."
      );
    }
    const preimage = operation.precondition.acceptedPreimages[0]!;
    const postimageMode = operation.postimage.mode;
    if (postimageMode === undefined) {
      throw new TypeError("A Cohort-to-Cohort upgrade postimage must retain an exact file mode.");
    }
    return Object.freeze({
      path: operation.path,
      precondition: {
        state: "known-file" as const,
        acceptedPreimages: [{ bytes: operation.postimage.bytes, mode: postimageMode }]
      },
      postimage: { bytes: preimage.bytes, mode: preimage.mode }
    });
  });
}

export function createConsumerUpgradeUseCase(ports: ConsumerUpgradePorts) {
  return async function upgrade(options: {
    readonly consumerRoot: string;
    readonly authorityRevision?: string;
    readonly to: string;
  }): Promise<ConsumerUpgradeExecutionV1> {
    const inspection = await ports.transaction.inspect({ consumerRoot: options.consumerRoot });
    if (inspection.state !== "idle") {
      return blocked(issue(inspection.code, "foundation-transaction", inspection.message));
    }
    const [input, assetCatalog] = await Promise.all([
      ports.input.read({ consumerRoot: options.consumerRoot }),
      ports.assets.read()
    ]);
    const source = compileConsumerIntegration({
      desired: input.desired,
      snapshot: input.snapshot,
      assetCatalog
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
    const authority = await ports.authority.read({
      cohortId: options.to,
      repository: input.desired.repository,
      ...(options.authorityRevision === undefined
        ? {}
        : { revision: options.authorityRevision })
    });
    if (!authority.cohort.upgradeFrom.includes(input.desired.cohort.cohortId)) {
      return blocked(issue(
        "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
        options.to,
        `Central authority does not permit an upgrade from ${input.desired.cohort.cohortId}.`
      ), authority);
    }
    const prepared = await ports.sandbox.prepare({
      authority,
      consumerRoot: input.root,
      current: input.desired
    });
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
    try {
      await ports.sandbox.activateAndVerify({
        authority,
        consumerRoot: input.root
      });
    } catch (activationError) {
      const rollbackPlan = compileKnownFileTransactionPlan({
        operations: reverseOperations(prepared.operations)
      });
      await ports.transaction.apply({ consumerRoot: input.root, plan: rollbackPlan });
      await ports.sandbox.restoreAndVerify({
        consumerRoot: input.root,
        current: input.desired
      });
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
