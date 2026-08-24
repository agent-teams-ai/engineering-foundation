import { canonicalJson, sha256Json, type CanonicalJsonValue } from "../../../canonical-json.js";
import { installedFoundationVersion } from "../../../package-version.js";
import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "../../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { ensureFoundationStateDirectory } from "../../../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import type {
  KnownFileTransactionOperationOutcome,
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1
} from "../../application/model/known-file-transaction.js";
import type { KnownFileTransactionJournalV1 } from "../../application/model/known-file-transaction-journal.js";
import { compileKnownFileTransactionEnvelope } from "../../application/policies/known-file-transaction-envelope.js";
import { assertKnownFileTransactionPlan } from "../../application/policies/known-file-transaction-plan.js";
import { cleanupCommittedKnownFileCaptures } from "./node-known-file-recovery-filesystem.js";
import type {
  KnownFileTransactionFaultInjector,
  KnownFileTransactionFaultPoint
} from "./node-known-file-apply-faults.js";
import {
  observeInitialKnownFileJournal,
  verifyApplyingKnownFilePostimages,
  verifyCommittedKnownFilePostimages
} from "./node-known-file-apply-observation.js";
import { executeKnownFileOperation } from "./node-known-file-apply-operation.js";
import {
  persistKnownFileApplyState,
  type KnownFileApplyState
} from "./node-known-file-apply-state.js";
import {
  canonicalKnownFileRoot,
  KnownFileTransactionError
} from "./node-known-file-transaction-filesystem.js";
import { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { inspectKnownFileTransactionBarrier } from "./node-known-file-transaction-inspection.js";

export { KnownFileTransactionError } from "./node-known-file-transaction-filesystem.js";
export type { KnownFileTransactionFaultInjector, KnownFileTransactionFaultPoint };

export function compileKnownFileTransactionReceipt(
  journal: KnownFileTransactionJournalV1,
  outcome: "already-satisfied" | "applied"
): KnownFileTransactionReceiptV1 {
  const operations = journal.operations.map((entry, index) => {
    const planOperation = journal.plan.operations[index]!;
    const operationOutcome: KnownFileTransactionOperationOutcome =
      entry.state === "already-satisfied"
        ? "already-satisfied"
        : planOperation.precondition.state === "absent" ? "created" : "replaced";
    return Object.freeze({
      path: entry.path,
      outcome: operationOutcome,
      resultDigest: planOperation.postimage.digest
    });
  });
  const body = {
    schemaVersion: 1 as const,
    protocol: "foundation.replace-known-file/v1" as const,
    planDigest: journal.plan.planDigest,
    outcome,
    operations: Object.freeze(operations)
  };
  return Object.freeze({
    ...body,
    receiptDigest: sha256Json({
      domain: "agent-teams.foundation.known-file-transaction-receipt/v1",
      body
    })
  });
}

export { verifyCommittedKnownFilePostimages } from "./node-known-file-apply-observation.js";

async function executeKnownFileApply(options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: KnownFileApplyState;
}): Promise<KnownFileTransactionReceiptV1> {
  for (let index = 0; index < options.stored.envelope.journal.plan.operations.length; index += 1) {
    await executeKnownFileOperation({ ...options, index });
  }
  await verifyApplyingKnownFilePostimages(options.root, options.stored.envelope.journal);
  await persistKnownFileApplyState(
    options.store,
    options.stored,
    options.stored.envelope.journal,
    "COMMITTED"
  );
  await options.faultInjector?.({ phase: "after-journal-committed" });
  await verifyCommittedKnownFilePostimages(options.root, options.stored.envelope.journal);
  await cleanupCommittedKnownFileCaptures(
    options.root,
    options.stored.envelope.journal,
    options.faultInjector
  );
  await verifyCommittedKnownFilePostimages(options.root, options.stored.envelope.journal);
  return compileKnownFileTransactionReceipt(options.stored.envelope.journal, "applied");
}

async function refreshBarrierRetention(
  store: NodeKnownFileTransactionJournalStore | undefined
): Promise<boolean> {
  if (store === undefined) {return false;}
  try {
    return await store.read() !== undefined;
  } catch {
    return true;
  }
}

export async function applyKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly faultInjector?: KnownFileTransactionFaultInjector;
}): Promise<KnownFileTransactionReceiptV1> {
  assertKnownFileTransactionPlan(options.plan);
  if (process.platform === "win32") {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_APPLY_UNSUPPORTED",
      "Known-file apply requires strict directory durability and is not qualified on Windows."
    );
  }
  const root = await canonicalKnownFileRoot(options.consumerRoot);
  const barrier = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  if (barrier.state !== "idle" && barrier.code === "KNOWN_FILE_RECOVERY_REQUIRED") {
    throw new KnownFileTransactionError(barrier.code, barrier.message);
  }
  const optimisticJournal = await observeInitialKnownFileJournal(root, options.plan);
  if (barrier.state === "idle" &&
    optimisticJournal.operations.every(({ state }) => state === "already-satisfied")) {
    return compileKnownFileTransactionReceipt(optimisticJournal, "already-satisfied");
  }
  const coordinator = await createNodeFoundationTransactionCoordinator(root);
  const lease = await coordinator.acquire({ requestedMutation: "known-file-transaction" });
  let retainBarrier = false;
  let store: NodeKnownFileTransactionJournalStore | undefined;
  try {
    await options.faultInjector?.({ phase: "after-barrier-acquired" });
    const journal = await observeInitialKnownFileJournal(root, options.plan);
    if (journal.operations.every(({ state }) => state === "already-satisfied")) {
      return compileKnownFileTransactionReceipt(journal, "already-satisfied");
    }
    const [version, buildIdentity] = await Promise.all([
      installedFoundationVersion(),
      installedFoundationBuildIdentity()
    ]);
    const envelope = compileKnownFileTransactionEnvelope({
      foundation: { version, buildIdentity },
      journal,
      state: "APPLYING"
    });
    store = new NodeKnownFileTransactionJournalStore(await ensureFoundationStateDirectory(root));
    const stored: KnownFileApplyState = {
      authority: await store.create(envelope),
      envelope
    };
    retainBarrier = true;
    await options.faultInjector?.({ phase: "after-journal-created" });
    const result = await executeKnownFileApply({
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      root,
      store,
      stored
    });
    await store.remove(stored.authority);
    await options.faultInjector?.({ phase: "after-journal-retired" });
    retainBarrier = false;
    return result;
  } catch (error) {
    retainBarrier = await refreshBarrierRetention(store);
    throw error;
  } finally {
    await lease.release({ retainTransactionBarrier: retainBarrier });
  }
}

export function canonicalKnownFileTransactionReceipt(
  value: KnownFileTransactionReceiptV1
): string {
  return `${canonicalJson(value as unknown as CanonicalJsonValue)}\n`;
}
