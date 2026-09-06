import { lstat } from "node:fs/promises";
import {
  applyKnownFileTransaction, inspectKnownFileTransactionBarrier, sha256Bytes
} from "@agent-teams/repository-mutation";
import {
  acquireMutationLease, claimMutation, observeMutationState, releaseMutationLease
} from "@agent-teams/repository-mutation/node";
import type { ConsumerRestorationExecution, ConsumerRestorationOptions, ConsumerRestorationProof } from "../application/model/consumer-restoration.js";
import type { ConsumerRestorationAuthorityReader, ConsumerRestorationRecorder } from "../application/ports/consumer-restoration.js";
import type { ConsumerUpgradeSandboxPort } from "../application/ports/consumer-upgrade.js";
import {
  assertFullyReplacedReceipt, inverseRestorationPlan,
  parseConsumerRestorationPreparation, requireRestoration, restorationJson
} from "../application/policies/consumer-restoration-proof.js";
import {
  assertRestorationImages, assertRestorationPlanSource, externalRestorationPath,
  historicalRestorationProfile, restorationArtifacts, restorationConsumer,
  restorationGit, restorationInventory, retainRestorationProof
} from "./node-consumer-restoration-evidence.js";
import { nodeConsumerIntegrationInputReader } from "./node-consumer-integration-repository.js";
import { assertRestorationBinding, readSelectedRestorationProof } from "./node-consumer-restoration-selection.js";
import { canonicalConsumerRoot } from "./node-consumer-repository-files.js";

export function consumerRestorationRecorder(authority: ConsumerRestorationAuthorityReader): ConsumerRestorationRecorder {
  return { prepare: async (options) => {
    const consumer = await restorationConsumer(options.consumerRoot, options.current.repository);
    const path = await externalRestorationPath(options.proofPath, consumer.root);
    const exists = await lstat(path).then(() => true, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {return false;}
      throw error;
    });
    requireRestoration(!exists, "proof destination already exists; preserve it.");
    requireRestoration((await restorationGit(consumer.root, ["rev-parse", "HEAD"])).toString().trim() === options.sourceRevision &&
      (await restorationGit(consumer.root, ["diff", "--no-ext-diff", "--no-textconv", options.sourceRevision, "--"])).length === 0,
    "restorable upgrade requires the exact unchanged source commit.");
    const current = await historicalRestorationProfile(consumer.root, options.sourceRevision);
    requireRestoration(restorationJson(current) === restorationJson(options.current), "source profile changed.");
    inverseRestorationPlan(options.plan);
    await assertRestorationPlanSource(consumer.root, options.sourceRevision, current, options.plan, options.target);
    const pending = {
      schemaVersion: 1 as const, protocol: "agent-teams.managed-v1-restoration-preparation/v1" as const,
      sourceGeneration: 1 as const, targetGeneration: 2 as const, consumer, initialProofPath: path,
      sourceRevision: options.sourceRevision,
      sourceTree: (await restorationGit(consumer.root, ["rev-parse", `${options.sourceRevision}^{tree}`])).toString().trim(),
      sourceInventoryDigest: await restorationInventory(consumer.root),
      sourceCohort: current.cohort, targetCohort: options.target,
      ...await restorationArtifacts(consumer.root), plan: options.plan
    };
    await assertRestorationAuthority(authority, pending);
    await assertRestorationImages(consumer.root, pending, true);
    const bytes = Buffer.from(`${restorationJson(pending)}\n`);
    parseConsumerRestorationPreparation(bytes, sha256Bytes(bytes));
    return retainRestorationProof(await externalRestorationPath(`${path}.prepared`, consumer.root), pending);
  } };
}

function isCentralRestorationAuthority(value: { readonly repository: unknown; readonly path: unknown }): boolean {
  return value.repository === "agent-teams-ai/.github" && value.path === "governance/docs-qualified-cohorts.json";
}

function assertRestoreGenerations(source: unknown, target: unknown): void {
  requireRestoration(source === 2 && target === 1, "restore requires explicit source generation 2 and target generation 1.");
}

export async function assertRestorationAuthority(reader: ConsumerRestorationAuthorityReader,
  proof: Pick<ConsumerRestorationProof, "sourceCohort" | "targetCohort" | "consumer">): Promise<void> {
  const authority = await reader.readRestoration({
    source: proof.targetCohort, origin: proof.sourceCohort, repository: proof.consumer.repository
  });
  requireRestoration(authority.source.revision === authority.target.revision &&
    isCentralRestorationAuthority(authority.source) && isCentralRestorationAuthority(authority.target) &&
    /^(?!0{40}$)[0-9a-f]{40}$/u.test(authority.source.revision) &&
    restorationJson(authority.source.cohort) === restorationJson(proof.targetCohort) &&
    restorationJson(authority.target.cohort) === restorationJson(proof.sourceCohort) &&
    proof.targetCohort.rollbackTo.includes(proof.sourceCohort.cohortId) &&
    proof.targetCohort.upgradeFrom.includes(proof.sourceCohort.cohortId) &&
    Date.parse(proof.sourceCohort.eligibleAfter) <= Date.now() &&
    Date.parse(proof.targetCohort.eligibleAfter) <= Date.now(),
  "fresh protected authority must authorize the exact qualified original rollback edge.");
}

export async function restoreNodeConsumerIntegration(options: ConsumerRestorationOptions, ports: {
  readonly authority: ConsumerRestorationAuthorityReader;
  readonly sandbox: ConsumerUpgradeSandboxPort;
  readonly apply?: typeof applyKnownFileTransaction;
}): Promise<ConsumerRestorationExecution> {
  assertRestoreGenerations(options.sourceGeneration, options.targetGeneration);
  const root = await canonicalConsumerRoot(options.consumerRoot);
  const { proof, digest } = await readSelectedRestorationProof(root, options);
  requireRestoration(options.from === proof.targetCohort.cohortId && options.to === proof.sourceCohort.cohortId,
    "command must name the exact recorded source and target Cohorts.");
  const source = await assertRestorationBinding(root, proof);  const inverse = inverseRestorationPlan(proof.plan);
  let receipt;
  const lease = await acquireMutationLease(root);
  try {
    await assertRestorationImages(root, proof, options.activationOnly === true);
    const observed = await nodeConsumerIntegrationInputReader.read({ consumerRoot: root });
    requireRestoration(restorationJson(observed.desired.cohort) ===
      restorationJson(options.activationOnly === true ? proof.sourceCohort : proof.targetCohort), "current Cohort is stale or mixed.");
    await assertRestorationAuthority(ports.authority, proof);
    await assertRestorationImages(root, proof, options.activationOnly === true);
    if (options.activationOnly !== true) {
      const claim = await claimMutation(lease, await observeMutationState(lease), {
        kind: "apply-known-file", planDigest: inverse.planDigest,
        ownerArtifact: proof.kernel, kernelArtifact: proof.kernel
      });
      receipt = await (ports.apply ?? applyKnownFileTransaction)({ consumerRoot: root, plan: inverse, claim });
      assertFullyReplacedReceipt(inverse, receipt);
    }
  } finally {await releaseMutationLease(lease);}
  // The historical CLI requires an idle kernel barrier. No success is emitted before it passes.
  await assertRestorationImages(root, proof, true);
  await ports.sandbox.restoreAndVerifyV1({ consumerRoot: root, current: source });
  await assertRestorationImages(root, proof, true);
  requireRestoration((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state === "idle",
    "transaction appeared during historical activation.");
  return {
    schemaVersion: 1 as const, command: "consumer.restore" as const,
    outcome: options.activationOnly === true ? "activated-v1" as const : "restored" as const,
    issues: [], proofDigest: digest, inversePlanDigest: inverse.planDigest,
    ...(receipt === undefined ? {} : { receipt })
  };
}
