import { canonicalJson, sha256Json, type CanonicalJsonValue } from "../../../canonical-json.js";
import { installedRepositoryMutationBuildIdentity } from "../../../installed-artifact-identity.js";
import { installedRepositoryMutationVersion, REPOSITORY_MUTATION_PACKAGE_NAME } from "../../../package-version.js";
import { ensureMutationStateDirectory } from "../../../transaction-coordination/adapters/node/node-state-directory.js";
import {
  acquireMutationLease, claimMutation, consumeMutationClaim, mutationClaimIntent, observeMutationState,
  retainMutationBarrierOnEvidence, retainMutationClaimBarrierOnEvidence,
  type MutationArtifactIdentity, type MutationClaim, type MutationLease
} from "../../../transaction-coordination/mutation-lease.js";
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
import { releaseKnownFileTransactionLease } from "./node-known-file-transaction-lease-release.js";

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
    protocol: "agent-teams.repository-mutation.known-file/v1" as const,
    planDigest: journal.plan.planDigest,
    outcome,
    operations: Object.freeze(operations)
  };
  return Object.freeze({
    ...body,
    receiptDigest: sha256Json({
      domain: "agent-teams.repository-mutation.known-file-receipt/v1",
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

async function installedMutationArtifact(): Promise<MutationArtifactIdentity> {
  const [version, buildIdentity] = await Promise.all([
    installedRepositoryMutationVersion(),
    installedRepositoryMutationBuildIdentity()
  ]);
  return { name: REPOSITORY_MUTATION_PACKAGE_NAME, version, buildIdentity };
}

async function ensureApplyClaim(options: {
  readonly artifact: MutationArtifactIdentity;
  readonly claim: MutationClaim | undefined;
  readonly lease: MutationLease | undefined;
  readonly planDigest: `sha256:${string}`;
}): Promise<MutationClaim> {
  if (options.claim !== undefined) {return options.claim;}
  if (options.lease === undefined) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_PLAN_INVALID",
      "Known-file apply did not acquire its mutation lease."
    );
  }
  return claimMutation(
    options.lease,
    await observeMutationState(options.lease),
    {
      kind: "apply-known-file",
      planDigest: options.planDigest,
      ownerArtifact: options.artifact,
      kernelArtifact: options.artifact
    }
  );
}

function sameArtifact(
  candidate: MutationArtifactIdentity,
  expected: MutationArtifactIdentity
): boolean {
  return candidate.name === expected.name &&
    candidate.version === expected.version &&
    candidate.buildIdentity === expected.buildIdentity;
}

async function assertApplyClaim(options: {
  readonly artifact: MutationArtifactIdentity;
  readonly claim: MutationClaim;
  readonly planDigest: `sha256:${string}`;
  readonly root: string;
}): Promise<void> {
  const intent = mutationClaimIntent(options.claim);
  if (intent.kind !== "apply-known-file" ||
    intent.planDigest !== options.planDigest ||
    !sameArtifact(intent.ownerArtifact, options.artifact) ||
    !sameArtifact(intent.kernelArtifact, options.artifact) ||
    await consumeMutationClaim(options.claim, "apply-known-file") !== options.root) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_PLAN_INVALID",
      "Mutation claim belongs to another repository root, plan, owner, or kernel identity."
    );
  }
}

function translateApplyAdmissionFailure(error: unknown): never {
  if (error instanceof Error && /Common transaction evidence/u.test(error.message)) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_REQUIRED",
      "Common transaction evidence must be recovered before known-file apply."
    );
  }
  throw error;
}

export async function applyKnownFileTransactionWithFaults(options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly claim?: MutationClaim;
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
  let ownedLease: MutationLease | undefined;
  let claim = options.claim;
  ownedLease = claim === undefined ? await acquireMutationLease(root) : undefined;
  let retainBarrier = false;
  let store: NodeKnownFileTransactionJournalStore | undefined;
  let primaryFailure: { readonly reason: unknown } | undefined;
  try {
    const mutationArtifact = await installedMutationArtifact();
    claim = await ensureApplyClaim({
      artifact: mutationArtifact,
      claim,
      lease: ownedLease,
      planDigest: options.plan.planDigest
    });
    await assertApplyClaim({
      artifact: mutationArtifact,
      claim,
      planDigest: options.plan.planDigest,
      root
    });
    await options.faultInjector?.({ phase: "after-barrier-acquired" });
    const journal = await observeInitialKnownFileJournal(root, options.plan);
    if (journal.operations.every(({ state }) => state === "already-satisfied")) {
      return compileKnownFileTransactionReceipt(journal, "already-satisfied");
    }
    const envelope = compileKnownFileTransactionEnvelope({
      ownerArtifact: mutationArtifact,
      kernelArtifact: mutationArtifact,
      journal,
      state: "APPLYING"
    });
    store = new NodeKnownFileTransactionJournalStore(await ensureMutationStateDirectory(root));
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
    if (claim !== undefined) {await retainMutationClaimBarrierOnEvidence(claim);}
    if (ownedLease !== undefined && !retainBarrier) {
      retainBarrier = await retainMutationBarrierOnEvidence(ownedLease);
    }
    primaryFailure = { reason: error };
    return translateApplyAdmissionFailure(error);
  } finally {
    if (ownedLease !== undefined) {await releaseKnownFileTransactionLease({
      jointFailureMessage: "Known-file apply and transaction lease release both failed.",
      lease: ownedLease,
      ...(primaryFailure === undefined ? {} : { primaryFailure }),
      retainTransactionBarrier: retainBarrier
    });}
  }
}

export function applyKnownFileTransaction(options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly claim?: MutationClaim;
}): Promise<KnownFileTransactionReceiptV1> {
  return applyKnownFileTransactionWithFaults(options);
}

export function canonicalKnownFileTransactionReceipt(
  value: KnownFileTransactionReceiptV1
): string {
  return `${canonicalJson(value as unknown as CanonicalJsonValue)}\n`;
}
