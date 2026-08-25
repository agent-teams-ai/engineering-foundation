import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import { pruneFoundationStateDirectory } from "../../../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import type { KnownFileTransactionReceiptV1 } from "../../application/model/known-file-transaction.js";
import { classifyKnownFileRecoveryTransition } from "../../application/policies/classify-known-file-recovery-transition.js";
import {
  executeApplyingKnownFileRollback,
  executeCommittedKnownFileRecovery,
  type KnownFileRecoveryFaultInjector
} from "./node-known-file-recovery-executor.js";
import {
  observeKnownFileRecoveryEvidence
} from "./node-known-file-recovery-observation.js";
import {
  canonicalKnownFileRoot,
  KnownFileTransactionError
} from "./node-known-file-transaction-filesystem.js";
import { releaseKnownFileTransactionLease } from "./node-known-file-transaction-lease-release.js";

export type { KnownFileRecoveryFaultInjector } from "./node-known-file-recovery-executor.js";

export async function recoverKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly faultInjector?: KnownFileRecoveryFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  if (process.platform === "win32") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_APPLY_UNSUPPORTED",
      "Known-file recovery requires strict directory durability and is not qualified on Windows."
    );
  }
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  const coordinator = await createNodeFoundationTransactionCoordinator(root);
  const lease = await coordinator.acquire({
    requestedMutation: "known-file-transaction",
    allowRecoveryOf: "known-file-transaction"
  });
  let retainBarrier = true;
  let primaryFailure: { readonly reason: unknown } | undefined;
  try {
    const evidence = await observeKnownFileRecoveryEvidence(root);
    const transition = classifyKnownFileRecoveryTransition({
      envelope: evidence.stored.envelope,
      installedBuild: evidence.installedBuild
    });
    if (transition.action === "reject") {
      throw new KnownFileTransactionError(transition.code, transition.message);
    }
    const execution = {
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      root,
      store: evidence.store,
      stored: evidence.stored
    };
    const result = transition.action === "resume-committed-cleanup"
      ? await executeCommittedKnownFileRecovery(execution)
      : await executeApplyingKnownFileRollback(execution);
    retainBarrier = false;
    return result;
  } catch (error) {
    primaryFailure = { reason: error };
    throw error;
  } finally {
    await releaseKnownFileTransactionLease({
      jointFailureMessage: "Known-file recovery and transaction lease release both failed.",
      lease,
      ...(primaryFailure === undefined ? {} : { primaryFailure }),
      retainTransactionBarrier: retainBarrier
    });
    if (!retainBarrier) {await pruneFoundationStateDirectory(root);}
  }
}
