import { applyKnownFileTransaction, sha256Bytes, type KnownFileTransactionReceiptV1 } from "@agent-teams/repository-mutation";
import { acquireMutationLease, claimMutation, observeMutationState, releaseMutationLease } from "@agent-teams/repository-mutation/node";
import {
  type ConsumerFinalizationOptions,
  type ConsumerRestorationPreparation,
  type ConsumerRestorationProof,
  type RestorableConsumerUpgradeExecution,
  type ConsumerRestorationAuthorityReader,
  assertFullyReplacedReceipt,
  assertObservedRestorationReceipt,
  exactRestorationKeys,
  parseConsumerRestorationProof,
  requireRestoration,
  restorationJson
} from "../application-api.js";

import type { ConsumerUpgradeAuthorityReader, ConsumerUpgradeSandboxPort } from "../application/ports/consumer-upgrade.js";

import { parseJsonRecord } from "./strict-json-record.js";
import { assertRestorationAuthority } from "./node-consumer-restoration.js";
import { assertRestorationImages, externalRestorationPath, retainRestorationProof, syncRestorationProof } from "./node-consumer-restoration-evidence.js";
import { assertRestorationBinding, readRestorationEvidence, readRestorationPreparation } from "./node-consumer-restoration-selection.js";
import { canonicalConsumerRoot } from "./node-consumer-repository-files.js";
import { nodeConsumerIntegrationInputReader } from "./node-consumer-integration-repository.js";

async function retainedReceipt(root: string, path: string, preparation: ConsumerRestorationPreparation, digest: string) {
  const file = await readRestorationEvidence(root, path, false);
  if (file.state === "absent") {return;}
  const value = exactRestorationKeys(parseJsonRecord(Buffer.from(file.bytes).toString("utf8")), ["preparationDigest", "receipt"]);
  requireRestoration(value["preparationDigest"] === digest, "receipt companion belongs to another selection; preserve it.");
  const receipt = value["receipt"] as KnownFileTransactionReceiptV1;
  assertObservedRestorationReceipt(preparation.plan, receipt);
  return receipt;
}

async function selectedImages(root: string, preparation: ConsumerRestorationPreparation): Promise<void> {
  // An interrupted APPLYING transaction must be recovered first; mixed images are not a new intent.
  const input = await nodeConsumerIntegrationInputReader.read({ consumerRoot: root });
  const source = input.desired.schemaVersion === 1;
  requireRestoration(restorationJson(input.desired.cohort) === restorationJson(source ? preparation.sourceCohort : preparation.targetCohort),
    "current source/target Cohort differs from the selection.");
  await assertRestorationImages(root, preparation, source);
}

function assertFinalizationGenerations(source: unknown, target: unknown): void {
  requireRestoration(source === 1 && target === 2, "finalize requires explicit generations 1->2.");
}

function isCentralFinalizationAuthority(value: { readonly repository: unknown; readonly path: unknown }): boolean {
  return value.repository === "agent-teams-ai/.github" && value.path === "governance/docs-qualified-cohorts.json";
}

function assertFinalizationTargetGeneration(value: unknown): void {
  requireRestoration(value === 2, "explicit V2 authority required.");
}

export async function finalizeNodeConsumerRestoration(options: ConsumerFinalizationOptions, ports: {
  readonly authority: ConsumerRestorationAuthorityReader & ConsumerUpgradeAuthorityReader;
  readonly sandbox: ConsumerUpgradeSandboxPort;
  readonly now?: () => number;
  readonly apply?: typeof applyKnownFileTransaction;
}): Promise<RestorableConsumerUpgradeExecution> {
  assertFinalizationGenerations(options.sourceGeneration, options.targetGeneration);
  const root = await canonicalConsumerRoot(options.consumerRoot);
  const preparation = await readRestorationPreparation(root, options.preparationPath, options.expect);
  requireRestoration(options.from === preparation.sourceCohort.cohortId && options.to === preparation.targetCohort.cohortId,
    "finalize must name the selected original source and target.");
  const path = await externalRestorationPath(options.proofPath, root);
  const existing = await readRestorationEvidence(root, path, false);
  // Existing completion is untrusted historical evidence until this attempt applies and activates.
  const complete = existing.state === "absent" ? undefined : parseConsumerRestorationProof(existing.bytes, sha256Bytes(existing.bytes));
  requireRestoration(complete === undefined || (complete.preparationDigest === options.expect && complete.proofPath === path),
    "existing final proof differs from the selected intent or destination; preserve it.");
  const receiptPath = await externalRestorationPath(`${path}.receipt`, root);
  let original = await retainedReceipt(root, receiptPath, preparation, options.expect);
  await assertRestorationBinding(root, preparation);
  let receipt: KnownFileTransactionReceiptV1;
  let authority;
  const lease = await acquireMutationLease(root);
  try {
    await selectedImages(root, preparation);
    authority = await ports.authority.read({ cohortId: options.to, generation: 2, repository: preparation.consumer.repository });
    requireRestoration(isCentralFinalizationAuthority(authority) &&
      /^(?!0{40}$)[0-9a-f]{40}$/u.test(authority.revision) && authority.cohort.schemaVersion === 2 &&
      restorationJson(authority.cohort) === restorationJson(preparation.targetCohort), "fresh upgrade authority differs from selected target.");
    await assertRestorationAuthority(ports.authority, preparation, ports.now);
    await selectedImages(root, preparation);
    if (complete !== undefined) {await assertRestorationImages(root, preparation, false);}
    const claim = await claimMutation(lease, await observeMutationState(lease), {
      kind: "apply-known-file", planDigest: preparation.plan.planDigest,
      ownerArtifact: preparation.kernel, kernelArtifact: preparation.kernel
    });
    receipt = await (ports.apply ?? applyKnownFileTransaction)({ consumerRoot: root, plan: preparation.plan, claim });
    assertObservedRestorationReceipt(preparation.plan, receipt);
  } finally {await releaseMutationLease(lease);}
  if (original === undefined) {
    await retainRestorationProof(receiptPath, { preparationDigest: options.expect, receipt });
    original = receipt;
  }
  assertFinalizationTargetGeneration(authority.cohort.schemaVersion);
  await assertRestorationImages(root, preparation, false);
  await ports.sandbox.activateAndVerifyV2({ consumerRoot: root, authority: { ...authority, cohort: authority.cohort } });
  await assertRestorationBinding(root, preparation);
  await assertRestorationImages(root, preparation, false);
  if (complete !== undefined) {
    await syncRestorationProof(path);
    const retained = await readRestorationEvidence(root, path);
    requireRestoration(retained.state === "file" && restorationJson(parseConsumerRestorationProof(retained.bytes, sha256Bytes(retained.bytes))) === restorationJson(complete),
      "completed proof changed during revalidation.");
    return { schemaVersion: 1, command: "consumer.finalize", outcome: "upgraded", issues: [], receipt,
      restoration: { path, digest: sha256Bytes(retained.bytes) } };
  }
  const fullyReplaced = original.operations.every(({ outcome }) => outcome === "replaced") ? original : null;
  if (fullyReplaced !== null) {assertFullyReplacedReceipt(preparation.plan, fullyReplaced);}
  const proof: ConsumerRestorationProof = {
    ...preparation, protocol: "agent-teams.managed-v1-restoration/v1", preparationDigest: options.expect as `sha256:${string}`,
    proofPath: path, receipt, originalReceipt: fullyReplaced, activation: "verified-current-v2"
  };
  const bytes = Buffer.from(`${restorationJson(proof)}\n`);
  parseConsumerRestorationProof(bytes, sha256Bytes(bytes));
  await externalRestorationPath(path, root);
  const restoration = await retainRestorationProof(path, proof);
  return { schemaVersion: 1, command: "consumer.finalize", outcome: "upgraded", issues: [], receipt, restoration };
}
