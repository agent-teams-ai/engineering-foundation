import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  compileKnownFileTransactionPlan,
  inspectKnownFileTransactionBarrier,
  parseStrictJson,
  sha256Bytes,
} from "@agent-teams/repository-mutation";
import {
  assertManagedSuccessorProfileV4,
  assertRestorationIdentities,
  exactRestorationKeys,
  inverseManagedGenerationPlan,
  MAXIMUM_RESTORATION_PROOF_BYTES,
  requireRestoration,
  restorationJson,
} from "../application-api.js";
import type {
  ManagedCommittedRestorationOptions,
  ManagedCurrentRestorationSelection,
  ManagedGenerationPreparation,
  ConsumerIntegrationPlanningPorts,
} from "../application-api.js";
import { compileConsumerIntegration } from "../application/use-cases/plan-consumer-integration.js";
import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import {
  assertManagedControllerRuntime,
  assertManagedOriginalIntent,
} from "./node-managed-restoration-preparation.js";
import {
  assertRestorationImages,
  restorationArtifacts,
  restorationConsumer,
  restorationGit,
  restorationInventory,
} from "./node-consumer-restoration-evidence.js";
import {
  INTEGRATION_PROFILE_PATH,
  readStableConsumerFile,
} from "./node-consumer-repository-files.js";
import { observeQualifiedPnpmLockfileV2 } from "./pnpm-lockfile-validator-v2.js";
import { assertCleanGitRoot } from "./consumer-upgrade-sandbox-support.js";

const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;

export function parseCurrentRestoration(
  bytes: Uint8Array,
  expect: string,
): ManagedCurrentRestorationSelection {
  requireRestoration(
    bytes.length > 0 &&
      bytes.length <= MAXIMUM_RESTORATION_PROOF_BYTES &&
      /^sha256:[0-9a-f]{64}$/u.test(expect) &&
      sha256Bytes(bytes) === expect,
    "current selection differs from separately retained digest.",
  );
  const value = parseStrictJson(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  const wire = exactRestorationKeys(value, [
    "schemaVersion",
    "protocol",
    "sourceGeneration",
    "targetGeneration",
    "originalPreparationDigest",
    "consumer",
    "sourceRevision",
    "sourceTree",
    "sourceInventoryDigest",
    "controller",
    "kernel",
    "plan",
  ]);
  requireRestoration(
    wire["schemaVersion"] === 1 &&
      wire["protocol"] === "agent-teams.managed-generation3-current-restoration/v1" &&
      wire["sourceGeneration"] === 3 &&
      wire["targetGeneration"] === 2 &&
      typeof wire["originalPreparationDigest"] === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(wire["originalPreparationDigest"]),
    "unsupported current restoration family.",
  );
  const selection = value as ManagedCurrentRestorationSelection;
  assertRestorationIdentities(selection);
  inverseManagedGenerationPlan(selection.plan);
  requireRestoration(
    `${restorationJson(value)}\n` === Buffer.from(bytes).toString("utf8"),
    "current selection must be canonical inert JSON.",
  );
  return selection;
}

export async function assertCurrentRestorationIdle(root: string): Promise<void> {
  const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  if (inspection.state !== "idle") {
    throw new ConsumerIntegrationNodeError(inspection.code, inspection.message);
  }
}

async function currentCommittedProfile(
  root: string,
  revision: string,
  preparation: ManagedGenerationPreparation,
) {
  const value = parseStrictJson(
    (await restorationGit(root, ["show", `${revision}:${INTEGRATION_PROFILE_PATH}`])).toString(
      "utf8",
    ),
  );
  await assertConsumerIntegrationProfileSchema(value);
  assertManagedSuccessorProfileV4(value);
  requireRestoration(
    restorationJson(value.cohort) === restorationJson(preparation.targetCohort) &&
      restorationJson(value.repository) === restorationJson(preparation.consumer.repository),
    "committed target differs from retained Cohort3/repository.",
  );
  return value;
}

async function committedInverse(
  root: string,
  revision: string,
  preparation: ManagedGenerationPreparation,
) {
  const operations = [];
  for (const operation of preparation.plan.operations) {
    requireRestoration(
      operation.precondition.state === "known-file",
      "original replacement preimage required.",
    );
    const bytes = await restorationGit(root, ["show", `${revision}:${operation.path}`]);
    const mode = (await restorationGit(root, ["ls-tree", revision, "--", operation.path]))
      .toString()
      .split(" ")[0];
    requireRestoration(
      sha256Bytes(bytes) === operation.postimage.digest &&
        mode ===
          (operation.postimage.mode === 0o644
            ? "100644"
            : operation.postimage.mode === 0o755
              ? "100755"
              : "unsupported"),
      `committed managed postimage changed at ${operation.path}; reverse overlapping Host changes first.`,
    );
    const original = operation.precondition.acceptedPreimages[0]!;
    operations.push({
      path: operation.path,
      precondition: {
        state: "known-file" as const,
        acceptedPreimages: [{ bytes, mode: operation.postimage.mode }],
      },
      postimage: { bytes: Buffer.from(original.contentBase64, "base64"), mode: original.mode },
    });
  }
  return compileKnownFileTransactionPlan({ operations });
}

export async function assertCurrentRestorationBinding(
  root: string,
  options: ManagedCommittedRestorationOptions,
  preparation: ManagedGenerationPreparation,
  selection?: ManagedCurrentRestorationSelection,
) {
  assertManagedControllerRuntime();
  requireRestoration(
    GIT_SHA.test(options.currentRevision) && GIT_SHA.test(options.currentTree),
    "current target requires explicit exact HEAD/tree.",
  );
  const consumer = await restorationConsumer(root, preparation.consumer.repository);
  const artifacts = await restorationArtifacts(root);
  requireRestoration(
    restorationJson(artifacts) ===
      restorationJson({ controller: preparation.controller, kernel: preparation.kernel }),
    "retain the exact original controller/kernel builds.",
  );
  requireRestoration(
    (await restorationGit(root, ["rev-parse", "HEAD"])).toString().trim() ===
      options.currentRevision &&
      (await restorationGit(root, ["rev-parse", "HEAD^{tree}"])).toString().trim() ===
        options.currentTree,
    "current target HEAD/tree is stale.",
  );
  try {
    await restorationGit(root, [
      "merge-base",
      "--is-ancestor",
      preparation.sourceRevision,
      options.currentRevision,
    ]);
  } catch {
    requireRestoration(false, "current target has unknown original-source lineage.");
  }
  const current = await assertManagedOriginalIntent(root, preparation);
  await currentCommittedProfile(root, options.currentRevision, preparation);
  const plan = await committedInverse(root, options.currentRevision, preparation);
  if (selection !== undefined) {
    requireRestoration(
      selection.originalPreparationDigest === options.expect &&
        selection.sourceRevision === options.currentRevision &&
        selection.sourceTree === options.currentTree &&
        restorationJson(selection.consumer) === restorationJson(consumer) &&
        restorationJson({ controller: selection.controller, kernel: selection.kernel }) ===
          restorationJson(artifacts) &&
        restorationJson(selection.plan) === restorationJson(plan),
      "current selection belongs to another root, HEAD, artifacts or exact inverse intent.",
    );
  }
  return { consumer, artifacts, current, plan };
}

/** Observe the current physical files without running a Cohort3 check in the Node24 controller. */
export async function assertCurrentTargetCurrent(
  root: string,
  revision: string,
  preparation: ManagedGenerationPreparation,
  planning: ConsumerIntegrationPlanningPorts,
): Promise<void> {
  const desired = await currentCommittedProfile(root, revision, preparation);
  const observation = (path: string, required = false) =>
    readStableConsumerFile(root, path, 32 * 1024 * 1024, required);
  const [
    integrationProfile,
    packageManifest,
    lockfile,
    agents,
    skill,
    callerWorkflow,
    managedState,
  ] = await Promise.all([
    observation(INTEGRATION_PROFILE_PATH, true),
    observation("package.json", true),
    observation("pnpm-lock.yaml", true),
    observation("AGENTS.md", true),
    observation(desired.skillPath),
    observation(desired.callerWorkflowPath),
    observation(desired.managedStatePath),
  ]);
  requireRestoration(lockfile.state === "file", "current target lock is missing.");
  observeQualifiedPnpmLockfileV2(lockfile.bytes, desired);
  const result = compileConsumerIntegration(
    {
      desired,
      snapshot: {
        integrationProfile,
        packageManifest,
        lockfile,
        agents,
        skill,
        callerWorkflow,
        managedState,
      },
    },
    planning,
  );
  requireRestoration(
    result.plan.outcome === "current",
    "committed managed target is foreign or not current.",
  );
}

export async function prepareCurrentRestoration(
  root: string,
  options: ManagedCommittedRestorationOptions,
  preparation: ManagedGenerationPreparation,
  planning: ConsumerIntegrationPlanningPorts,
): Promise<ManagedCurrentRestorationSelection> {
  requireRestoration(
    (await assertCleanGitRoot(root)) === options.currentRevision,
    "current target must be clean and committed.",
  );
  const bound = await assertCurrentRestorationBinding(root, options, preparation);
  await assertCurrentTargetCurrent(root, options.currentRevision, preparation, planning);
  const sourceInventoryDigest = await restorationInventory(root);
  requireRestoration(
    (await assertCleanGitRoot(root)) === options.currentRevision,
    "current target changed during admission.",
  );
  return {
    schemaVersion: 1,
    protocol: "agent-teams.managed-generation3-current-restoration/v1",
    sourceGeneration: 3,
    targetGeneration: 2,
    originalPreparationDigest: options.expect,
    consumer: bound.consumer,
    sourceRevision: options.currentRevision,
    sourceTree: options.currentTree,
    sourceInventoryDigest,
    ...bound.artifacts,
    plan: bound.plan,
  };
}

export async function assertCurrentSelectionImages(
  root: string,
  selection: ManagedCurrentRestorationSelection,
): Promise<void> {
  // The current intent's preimages are the admitted committed target, not the old source root.
  try {
    await assertRestorationImages(root, selection, true);
  } catch {
    await assertRestorationImages(root, selection, false);
  }
}
