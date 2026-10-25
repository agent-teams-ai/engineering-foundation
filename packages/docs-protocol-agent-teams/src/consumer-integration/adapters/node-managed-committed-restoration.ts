import { applyKnownFileTransaction, sha256Bytes } from "@agent-teams/repository-mutation";
import type { KnownFileTransactionReceiptV1 } from "@agent-teams/repository-mutation";
import {
  acquireMutationLease,
  claimMutation,
  observeMutationState,
  releaseMutationLease,
} from "@agent-teams/repository-mutation/node";
import { assertObservedRestorationReceipt, requireRestoration } from "../application-api.js";
import type {
  ManagedCommittedRestorationOptions,
  ConsumerRestorationExecution,
  ConsumerIntegrationPlanningPorts,
  ManagedRestorationAuthorityReader,
} from "../application-api.js";
import type { ConsumerUpgradeSandboxPort } from "../application/ports/consumer-upgrade.js";
import { canonicalConsumerRoot } from "./node-consumer-repository-files.js";
import {
  assertManagedControllerRuntime,
  assertManagedGenerations,
  assertManagedRestorationAuthority,
  managedSourcePackageManager,
  readManagedPreparation,
} from "./node-managed-restoration-preparation.js";
import {
  assertRestorationImages,
  externalRestorationPath,
  retainRestorationProof,
  syncRestorationProof,
} from "./node-consumer-restoration-evidence.js";
import { readRestorationEvidence } from "./node-consumer-restoration-selection.js";
import {
  assertCurrentRestorationBinding,
  assertCurrentRestorationIdle,
  assertCurrentSelectionImages,
  parseCurrentRestoration,
  prepareCurrentRestoration,
} from "./node-managed-current-selection.js";

export async function restoreCommittedManagedConsumer(
  options: ManagedCommittedRestorationOptions,
  ports: {
    readonly authority: ManagedRestorationAuthorityReader;
    readonly sandbox: ConsumerUpgradeSandboxPort;
    readonly planning: ConsumerIntegrationPlanningPorts;
    readonly apply?: typeof applyKnownFileTransaction;
  },
): Promise<ConsumerRestorationExecution> {
  assertManagedGenerations(options.sourceGeneration, options.targetGeneration, true);
  assertManagedControllerRuntime();
  const root = await canonicalConsumerRoot(options.consumerRoot);
  await assertCurrentRestorationIdle(root);
  const preparation = await readManagedPreparation(root, options.preparationPath, options.expect);
  requireRestoration(
    options.from === preparation.targetCohort.cohortId &&
      options.to === preparation.sourceCohort.cohortId,
    "current restore must name the selected exact rollback edge.",
  );
  const path = await externalRestorationPath(options.selectionPath, root);
  const retained = await readRestorationEvidence(root, path, false);
  requireRestoration(
    retained.state === "absent"
      ? options.selectionExpect === undefined
      : options.selectionExpect !== undefined,
    "an existing current selection requires its separately selected digest; never repeat an uncertain write.",
  );
  let selection =
    retained.state === "file"
      ? parseCurrentRestoration(retained.bytes, options.selectionExpect!)
      : undefined;
  let digest = retained.state === "file" ? sha256Bytes(retained.bytes) : undefined;
  const packageManager = await managedSourcePackageManager(root, preparation);
  await ports.sandbox.verifyManagedRuntime({ cohort: preparation.sourceCohort, packageManager });
  const lease = await acquireMutationLease(root);
  let receipt: KnownFileTransactionReceiptV1;
  try {
    if (selection === undefined) {
      selection = await prepareCurrentRestoration(root, options, preparation, ports.planning);
      await assertManagedRestorationAuthority(ports.authority, preparation);
      await assertCurrentSelectionImages(root, selection);
      const selected = await retainRestorationProof(path, selection);
      digest = selected.digest;
    } else {
      await assertCurrentRestorationBinding(root, options, preparation, selection);
      await assertCurrentSelectionImages(root, selection);
      await assertManagedRestorationAuthority(ports.authority, preparation);
      await syncRestorationProof(path);
    }
    await assertCurrentRestorationBinding(root, options, preparation, selection);
    await assertCurrentSelectionImages(root, selection);
    await assertManagedRestorationAuthority(ports.authority, preparation);
    const selectedBeforeApply = await readRestorationEvidence(root, path);
    requireRestoration(
      selectedBeforeApply.state === "file" && sha256Bytes(selectedBeforeApply.bytes) === digest,
      "current selection changed before publication.",
    );
    const claim = await claimMutation(lease, await observeMutationState(lease), {
      kind: "apply-known-file",
      planDigest: selection.plan.planDigest,
      ownerArtifact: selection.kernel,
      kernelArtifact: selection.kernel,
    });
    receipt = await (ports.apply ?? applyKnownFileTransaction)({
      consumerRoot: root,
      plan: selection.plan,
      claim,
    });
    assertObservedRestorationReceipt(selection.plan, receipt);
  } finally {
    await releaseMutationLease(lease);
  }
  await assertRestorationImages(root, selection, false);
  const bound = await assertCurrentRestorationBinding(root, options, preparation, selection);
  await ports.sandbox.restoreCommittedAndVerifyManaged({
    consumerRoot: root,
    current: bound.current,
  });
  await assertCurrentRestorationBinding(root, options, preparation, selection);
  await assertRestorationImages(root, selection, false);
  await assertManagedRestorationAuthority(ports.authority, preparation);
  const completed = await readRestorationEvidence(root, path);
  requireRestoration(
    completed.state === "file" && sha256Bytes(completed.bytes) === digest,
    "selected current intent changed during restoration.",
  );
  await assertCurrentRestorationIdle(root);
  return {
    schemaVersion: 1,
    command: "consumer.restore",
    outcome: "restored",
    issues: [],
    proofDigest: digest,
    inversePlanDigest: selection.plan.planDigest,
    receipt,
  };
}
