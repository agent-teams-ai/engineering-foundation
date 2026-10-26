import { applyKnownFileTransaction, sha256Bytes } from "@agent-teams/repository-mutation";
import type { KnownFileTransactionReceiptV1 } from "@agent-teams/repository-mutation";
import {
  acquireMutationLease,
  claimMutation,
  observeMutationState,
  releaseMutationLease,
} from "@agent-teams/repository-mutation/node";
import {
  assertObservedRestorationReceipt,
  exactRestorationKeys,
  inverseManagedGenerationPlan,
  requireRestoration,
  restorationJson,
} from "../application-api.js";
import type {
  ManagedGenerationFinalizationOptions,
  ManagedGenerationPreparation,
  ManagedGenerationRestorationOptions,
  ConsumerRestorationExecution,
  RestorableConsumerUpgradeExecution,
  ManagedRestorationAuthorityReader,
} from "../application-api.js";
import type {
  ConsumerUpgradeAuthorityReader,
  ConsumerUpgradeSandboxPort,
} from "../application/ports/consumer-upgrade.js";
import {
  assertRestorationImages,
  externalRestorationPath,
  retainRestorationProof,
  syncRestorationProof,
  restorationGit,
} from "./node-consumer-restoration-evidence.js";
import { readRestorationEvidence } from "./node-consumer-restoration-selection.js";
import {
  assertManagedPreparationBinding,
  assertManagedPreparationSourceBinding,
  assertManagedGenerations,
  isCentralManagedAuthority,
  assertManagedRestorationAuthority,
  readManagedPreparation,
} from "./node-managed-restoration-preparation.js";
import {
  canonicalConsumerRoot,
  readStableConsumerFile,
  INTEGRATION_PROFILE_PATH,
} from "./node-consumer-repository-files.js";
import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import { parseJsonRecord } from "./strict-json-record.js";

interface ManagedRestorationPorts {
  readonly authority: ManagedRestorationAuthorityReader & ConsumerUpgradeAuthorityReader;
  readonly sandbox: ConsumerUpgradeSandboxPort;
  readonly apply?: typeof applyKnownFileTransaction;
}

async function selectedImages(root: string, preparation: ManagedGenerationPreparation) {
  const profile = await readStableConsumerFile(root, INTEGRATION_PROFILE_PATH, 1024 * 1024, true);
  requireRestoration(profile.state === "file", "selected profile missing.");
  const desired = parseJsonRecord(Buffer.from(profile.bytes).toString("utf8"));
  await assertConsumerIntegrationProfileSchema(desired);
  requireRestoration(
    desired["schemaVersion"] === 3 || desired["schemaVersion"] === 4,
    "selected consumer generation changed.",
  );
  const source = desired["schemaVersion"] === 3;
  requireRestoration(
    restorationJson(desired["cohort"]) ===
      restorationJson(source ? preparation.sourceCohort : preparation.targetCohort),
    "consumer binding differs from selected original/target.",
  );
  await assertRestorationImages(root, preparation, source);
  return source;
}

async function preflightSelectedRuntime(
  root: string,
  preparation: ManagedGenerationPreparation,
  ports: ManagedRestorationPorts,
  target: boolean,
): Promise<void> {
  const operation = preparation.plan.operations.find(({ path }) => path === "package.json");
  const bytes =
    target && operation !== undefined
      ? Buffer.from(operation.postimage.contentBase64, "base64")
      : await restorationGit(root, ["show", `${preparation.sourceRevision}:package.json`]);
  const packageManager = parseJsonRecord(bytes.toString("utf8"))["packageManager"];
  requireRestoration(
    typeof packageManager === "string",
    "selected exact packageManager is missing.",
  );
  await ports.sandbox.verifyManagedRuntime({
    cohort: target ? preparation.targetCohort : preparation.sourceCohort,
    packageManager,
  });
}

async function targetAuthority(
  ports: ManagedRestorationPorts,
  preparation: ManagedGenerationPreparation,
) {
  const rollback = await assertManagedRestorationAuthority(ports.authority, preparation);
  const selected = await ports.authority.read({
    cohortId: preparation.targetCohort.cohortId,
    generation: 3,
    revision: rollback.revision,
    repository: preparation.consumer.repository,
  });
  requireRestoration(
    isCentralManagedAuthority(selected) &&
      selected.revision === rollback.revision &&
      selected.cohort.schemaVersion === 3 &&
      restorationJson(selected.cohort) === restorationJson(preparation.targetCohort),
    "fresh protected selection differs from retained target.",
  );
  return { ...selected, cohort: selected.cohort };
}

async function retainedRecord(root: string, path: string) {
  const file = await readRestorationEvidence(root, path, false);
  if (file.state === "absent") {
    return;
  }
  return { file, value: parseJsonRecord(Buffer.from(file.bytes).toString("utf8")) };
}

function validateReceiptRecord(
  value: unknown,
  preparation: ManagedGenerationPreparation,
  digest: string,
): KnownFileTransactionReceiptV1 {
  const record = exactRestorationKeys(value, ["preparationDigest", "receipt"]);
  requireRestoration(
    record["preparationDigest"] === digest,
    "receipt companion belongs to another preparation; preserve it.",
  );
  assertObservedRestorationReceipt(preparation.plan, record["receipt"]);
  return record["receipt"] as KnownFileTransactionReceiptV1;
}

function validateCompletion(
  value: unknown,
  preparation: ManagedGenerationPreparation,
  digest: string,
): void {
  const record = exactRestorationKeys(value, [
    "schemaVersion",
    "protocol",
    "preparationDigest",
    "receipt",
    "activation",
  ]);
  requireRestoration(
    record["schemaVersion"] === 1 &&
      record["protocol"] === "agent-teams.managed-generation3-completion/v1" &&
      record["preparationDigest"] === digest &&
      record["activation"] === "verified-current-v3",
    "completion differs from explicit preparation; preserve it.",
  );
  assertObservedRestorationReceipt(preparation.plan, record["receipt"]);
}

async function activateSelectedManaged(input: {
  readonly options: ManagedGenerationFinalizationOptions;
  readonly ports: ManagedRestorationPorts;
  readonly authority: Awaited<ReturnType<typeof targetAuthority>>;
  readonly receipt: KnownFileTransactionReceiptV1;
  readonly preparation: ManagedGenerationPreparation;
}): Promise<void> {
  try {
    await input.ports.sandbox.activateAndVerifyManaged({
      consumerRoot: input.options.consumerRoot,
      authority: input.authority,
    });
  } catch (error) {
    // Only this live attempt's authentic all-replaced receipt grants automatic compensation.
    // A cold already-satisfied observation requires an explicit proof-selected restore instead.
    if (input.receipt.operations.every((operation) => operation.outcome === "replaced")) {
      await restoreManagedConsumerIntegration(
        {
          consumerRoot: input.options.consumerRoot,
          sourceGeneration: 3,
          targetGeneration: 2,
          from: input.preparation.targetCohort.cohortId,
          to: input.preparation.sourceCohort.cohortId,
          preparationPath: input.options.preparationPath,
          expect: input.options.expect,
        },
        input.ports,
      );
    }
    throw error;
  }
}

export async function finalizeManagedConsumerRestoration(
  options: ManagedGenerationFinalizationOptions,
  ports: ManagedRestorationPorts,
): Promise<RestorableConsumerUpgradeExecution> {
  assertManagedGenerations(options.sourceGeneration, options.targetGeneration, false);
  const root = await canonicalConsumerRoot(options.consumerRoot);
  const preparation = await readManagedPreparation(root, options.preparationPath, options.expect);
  requireRestoration(
    options.from === preparation.sourceCohort.cohortId &&
      options.to === preparation.targetCohort.cohortId,
    "finalize must name selected source and target.",
  );
  const path = await externalRestorationPath(options.proofPath, root);
  requireRestoration(
    path === preparation.initialProofPath,
    "completion destination must equal retained preparation destination.",
  );
  const existing = await retainedRecord(root, path);
  if (existing !== undefined) {
    validateCompletion(existing.value, preparation, options.expect);
  }
  const receiptPath = await externalRestorationPath(`${path}.receipt`, root);
  const companion = await retainedRecord(root, receiptPath);
  if (companion !== undefined) {
    validateReceiptRecord(companion.value, preparation, options.expect);
  }
  await assertManagedPreparationBinding(root, preparation);
  await preflightSelectedRuntime(root, preparation, ports, true);
  let receipt: KnownFileTransactionReceiptV1;
  let authority;
  const lease = await acquireMutationLease(root);
  try {
    const source = await selectedImages(root, preparation);
    requireRestoration(
      existing === undefined || !source,
      "completed selection cannot silently publish again after rollback.",
    );
    authority = await targetAuthority(ports, preparation);
    await selectedImages(root, preparation);
    await assertManagedPreparationSourceBinding(root, preparation);
    const claim = await claimMutation(lease, await observeMutationState(lease), {
      kind: "apply-known-file",
      planDigest: preparation.plan.planDigest,
      ownerArtifact: preparation.kernel,
      kernelArtifact: preparation.kernel,
    });
    receipt = await (ports.apply ?? applyKnownFileTransaction)({
      consumerRoot: root,
      plan: preparation.plan,
      claim,
    });
    assertObservedRestorationReceipt(preparation.plan, receipt);
  } finally {
    await releaseMutationLease(lease);
  }
  // An interrupted attempt can have published all files but lost this companion. The next call
  // re-observes an honest already-satisfied RM receipt; it never invents original write ownership.
  if (companion === undefined) {
    await retainRestorationProof(receiptPath, { preparationDigest: options.expect, receipt });
  }
  await assertRestorationImages(root, preparation, false);
  await activateSelectedManaged({ options, ports, authority, receipt, preparation });
  await assertManagedPreparationBinding(root, preparation);
  await assertRestorationImages(root, preparation, false);
  const confirmed = await targetAuthority(ports, preparation);
  requireRestoration(
    confirmed.revision === authority.revision,
    "protected authority advanced during activation; revalidate selected preparation.",
  );
  if (existing === undefined) {
    await retainRestorationProof(path, {
      schemaVersion: 1,
      protocol: "agent-teams.managed-generation3-completion/v1",
      preparationDigest: options.expect,
      receipt,
      activation: "verified-current-v3",
    });
  } else {
    await syncRestorationProof(path);
  }
  const completed = await retainedRecord(root, path);
  requireRestoration(completed !== undefined, "completion disappeared.");
  validateCompletion(completed.value, preparation, options.expect);
  if (existing !== undefined) {
    requireRestoration(
      sha256Bytes(completed.file.bytes) === sha256Bytes(existing.file.bytes),
      "completion changed during activation.",
    );
  }
  return {
    schemaVersion: 1,
    command: "consumer.finalize",
    outcome: "upgraded",
    issues: [],
    receipt,
    restoration: { path, digest: sha256Bytes(completed.file.bytes) },
  };
}

export async function restoreManagedConsumerIntegration(
  options: ManagedGenerationRestorationOptions,
  ports: ManagedRestorationPorts,
): Promise<ConsumerRestorationExecution> {
  assertManagedGenerations(options.sourceGeneration, options.targetGeneration, true);
  const root = await canonicalConsumerRoot(options.consumerRoot);
  const preparation = await readManagedPreparation(root, options.preparationPath, options.expect);
  requireRestoration(
    options.from === preparation.targetCohort.cohortId &&
      options.to === preparation.sourceCohort.cohortId,
    "restore must name exact retained rollback edge.",
  );
  const current = await assertManagedPreparationBinding(root, preparation);
  await preflightSelectedRuntime(root, preparation, ports, false);
  const inverse = inverseManagedGenerationPlan(preparation.plan);
  let receipt: KnownFileTransactionReceiptV1;
  const lease = await acquireMutationLease(root);
  try {
    await selectedImages(root, preparation);
    await assertManagedRestorationAuthority(ports.authority, preparation);
    await selectedImages(root, preparation);
    await assertManagedPreparationSourceBinding(root, preparation);
    const claim = await claimMutation(lease, await observeMutationState(lease), {
      kind: "apply-known-file",
      planDigest: inverse.planDigest,
      ownerArtifact: preparation.kernel,
      kernelArtifact: preparation.kernel,
    });
    receipt = await (ports.apply ?? applyKnownFileTransaction)({
      consumerRoot: root,
      plan: inverse,
      claim,
    });
    assertObservedRestorationReceipt(inverse, receipt);
  } finally {
    await releaseMutationLease(lease);
  }
  await assertRestorationImages(root, preparation, true);
  await ports.sandbox.restoreAndVerifyManaged({ consumerRoot: root, current });
  await assertManagedPreparationBinding(root, preparation);
  await assertRestorationImages(root, preparation, true);
  await assertManagedRestorationAuthority(ports.authority, preparation);
  return {
    schemaVersion: 1,
    command: "consumer.restore",
    outcome: "restored",
    issues: [],
    proofDigest: options.expect,
    inversePlanDigest: inverse.planDigest,
    receipt,
  };
}
