import { compileKnownFileTransactionReceipt } from "../../application/policies/known-file-transaction-receipt.js";
import type { KnownFileCoordination } from "./known-file-coordination.js";

import { REPOSITORY_MUTATION_PACKAGE_NAME, type MutationArtifactIdentity, type MutationClaim, type MutationLease } from "../../../transaction-coordination/application-api.js";



import type {
  KnownFileTransactionPlanV1,
  KnownFileTransactionReceiptV1
} from "../../application/model/known-file-transaction.js";
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
import { canonicalKnownFileRoot, hasPlainKnownFileOptionsPrototype } from "./node-known-file-transaction-filesystem.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";
import { NodeKnownFileTransactionJournalStore } from "./node-known-file-transaction-journal-store.js";
import { releaseKnownFileTransactionLease } from "./node-known-file-transaction-lease-release.js";

export type { KnownFileTransactionFaultInjector, KnownFileTransactionFaultPoint };

export { verifyCommittedKnownFilePostimages } from "./node-known-file-apply-observation.js";

async function executeKnownFileApply(coordination: Pick<KnownFileCoordination,
  "captureFileHandleIdentity"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
>, options: {
  readonly faultInjector?: KnownFileTransactionFaultInjector;
  readonly root: string;
  readonly store: NodeKnownFileTransactionJournalStore;
  readonly stored: KnownFileApplyState;
}): Promise<KnownFileTransactionReceiptV1> {
  for (let index = 0; index < options.stored.envelope.payload.plan.operations.length; index += 1) {
    await executeKnownFileOperation(coordination, { ...options, index });
  }
  await verifyApplyingKnownFilePostimages(coordination, options.root, options.stored.envelope.payload);
  await persistKnownFileApplyState(
    options.store,
    options.stored,
    options.stored.envelope.payload,
    "COMMITTED"
  );
  await options.faultInjector?.({ phase: "after-journal-committed" });
  await verifyCommittedKnownFilePostimages(coordination, options.root, options.stored.envelope.payload);
  await cleanupCommittedKnownFileCaptures(coordination,
    options.root,
    options.stored.envelope.payload,
    options.faultInjector
  );
  await verifyCommittedKnownFilePostimages(coordination, options.root, options.stored.envelope.payload);
  return compileKnownFileTransactionReceipt(options.stored.envelope.payload, "applied");
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

async function installedMutationArtifact(coordination: Pick<KnownFileCoordination, "installedRepositoryMutationBuildIdentity" | "installedRepositoryMutationVersion">, ): Promise<MutationArtifactIdentity> {
  const [version, buildIdentity] = await Promise.all([
    coordination.installedRepositoryMutationVersion(),
    coordination.installedRepositoryMutationBuildIdentity()
  ]);
  return { name: REPOSITORY_MUTATION_PACKAGE_NAME, version, buildIdentity };
}

async function ensureApplyClaim(coordination: Pick<KnownFileCoordination, "claimMutation" | "observeMutationState">, options: {
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
  return coordination.claimMutation(
    options.lease,
    await coordination.observeMutationState(options.lease),
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

async function assertApplyClaim(coordination: Pick<KnownFileCoordination, "consumeMutationClaim" | "mutationClaimIntent">, options: {
  readonly artifact: MutationArtifactIdentity;
  readonly claim: MutationClaim;
  readonly planDigest: `sha256:${string}`;
  readonly root: string;
}): Promise<void> {
  const intent = coordination.mutationClaimIntent(options.claim);
  if (intent.kind !== "apply-known-file" ||
    intent.planDigest !== options.planDigest ||
    !sameArtifact(intent.ownerArtifact, options.artifact) ||
    !sameArtifact(intent.kernelArtifact, options.artifact) ||
    await coordination.consumeMutationClaim(options.claim, "apply-known-file") !== options.root) {
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

export async function applyKnownFileTransactionWithFaults(coordination: Pick<KnownFileCoordination,
  "acquireMutationLease"
  | "assertTerminalEvidenceDirectory"
  | "captureFileHandleIdentity"
  | "claimMutation"
  | "consumeMutationClaim"
  | "ensureMutationStateDirectory"
  | "ensureTerminalEvidenceDirectory"
  | "installedRepositoryMutationBuildIdentity"
  | "installedRepositoryMutationVersion"
  | "mutationClaimIntent"
  | "observeMutationState"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
  | "releaseMutationLease"
  | "retainMutationBarrier"
  | "retainMutationBarrierOnEvidence"
  | "retainMutationClaimBarrierOnEvidence"
>, options: {
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
  ownedLease = claim === undefined ? await coordination.acquireMutationLease(root) : undefined;
  let retainBarrier = false;
  let store: NodeKnownFileTransactionJournalStore | undefined;
  let primaryFailure: { readonly reason: unknown } | undefined;
  try {
    const mutationArtifact = await installedMutationArtifact(coordination);
    claim = await ensureApplyClaim(coordination, {
      artifact: mutationArtifact,
      claim,
      lease: ownedLease,
      planDigest: options.plan.planDigest
    });
    await assertApplyClaim(coordination, {
      artifact: mutationArtifact,
      claim,
      planDigest: options.plan.planDigest,
      root
    });
    await options.faultInjector?.({ phase: "after-barrier-acquired" });
    const journal = await observeInitialKnownFileJournal(coordination, root, options.plan);
    if (journal.operations.every(({ state }) => state === "already-satisfied")) {
      return compileKnownFileTransactionReceipt(journal, "already-satisfied");
    }
    const envelope = compileKnownFileTransactionEnvelope({
      ownerArtifact: mutationArtifact,
      kernelArtifact: mutationArtifact,
      journal,
      state: "APPLYING"
    });
    store = new NodeKnownFileTransactionJournalStore(coordination,
      await coordination.ensureMutationStateDirectory(root),
      mutationArtifact,
      mutationArtifact
    );
    const stored: KnownFileApplyState = {
      authority: await store.create(envelope),
      envelope
    };
    retainBarrier = true;
    await options.faultInjector?.({ phase: "after-journal-created" });
    const result = await executeKnownFileApply(coordination, {
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
    if (claim !== undefined) {await coordination.retainMutationClaimBarrierOnEvidence(claim);}
    if (ownedLease !== undefined && !retainBarrier) {
      retainBarrier = await coordination.retainMutationBarrierOnEvidence(ownedLease);
    }
    primaryFailure = { reason: error };
    return translateApplyAdmissionFailure(error);
  } finally {
    if (ownedLease !== undefined) {await releaseKnownFileTransactionLease(coordination, {
      jointFailureMessage: "Known-file apply and transaction lease release both failed.",
      lease: ownedLease,
      ...(primaryFailure === undefined ? {} : { primaryFailure }),
      retainTransactionBarrier: retainBarrier
    });}
  }
}

export function applyKnownFileTransaction(coordination: Pick<KnownFileCoordination,
  "acquireMutationLease"
  | "assertTerminalEvidenceDirectory"
  | "captureFileHandleIdentity"
  | "claimMutation"
  | "consumeMutationClaim"
  | "ensureMutationStateDirectory"
  | "ensureTerminalEvidenceDirectory"
  | "installedRepositoryMutationBuildIdentity"
  | "installedRepositoryMutationVersion"
  | "mutationClaimIntent"
  | "observeMutationState"
  | "pathMatchesRegularFileIdentity"
  | "readBoundedRegularFile"
  | "readBoundedRegularFileHandle"
  | "releaseMutationLease"
  | "retainMutationBarrier"
  | "retainMutationBarrierOnEvidence"
  | "retainMutationClaimBarrierOnEvidence"
>, options: {
  readonly consumerRoot: string;
  readonly plan: KnownFileTransactionPlanV1;
  readonly claim?: MutationClaim;
}): Promise<KnownFileTransactionReceiptV1> {
  const candidate: unknown = options;
  const keys = typeof candidate === "object" && candidate !== null
    ? Reflect.ownKeys(candidate)
    : [];
  const expectedKeys = keys.includes("claim")
    ? ["claim", "consumerRoot", "plan"]
    : ["consumerRoot", "plan"];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
    !hasPlainKnownFileOptionsPrototype(candidate) ||
    keys.some((key) => typeof key !== "string") ||
    (keys as string[]).toSorted().join("\0") !== expectedKeys.toSorted().join("\0") ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      return descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true;
    })) {
    return Promise.reject(new KnownFileTransactionError(
      "KNOWN_FILE_PLAN_INVALID",
      "Known-file apply options contain unknown, missing, or executable properties."
    ));
  }
  const values = Object.fromEntries(keys.map((key) => [
    key as string,
    (Object.getOwnPropertyDescriptor(options, key)! as PropertyDescriptor & { value: unknown }).value
  ]));
  const input = Object.hasOwn(values, "claim")
    ? { consumerRoot: values["consumerRoot"] as string, plan: values["plan"] as KnownFileTransactionPlanV1, claim: values["claim"] as MutationClaim }
    : { consumerRoot: values["consumerRoot"] as string, plan: values["plan"] as KnownFileTransactionPlanV1 };
  return applyKnownFileTransactionWithFaults(coordination, input);
}
