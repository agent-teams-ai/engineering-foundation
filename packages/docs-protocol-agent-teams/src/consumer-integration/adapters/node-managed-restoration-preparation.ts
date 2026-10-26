import { parseJsonRecord } from "./strict-json-record.js";
import {
  inspectKnownFileTransactionBarrier,
  parseStrictJson,
  sha256Bytes,
} from "@agent-teams/repository-mutation";
import {
  assertConsumerIntegrationDesiredStateV3,
  assertManagedSuccessorProfileV4,
  assertQualifiedDocsCohortBindingV2,
  requireRestoration,
  restorationJson,
  assertRestorationIdentities,
  exactRestorationKeys,
  inverseManagedGenerationPlan,
  MAXIMUM_RESTORATION_PROOF_BYTES,
} from "../application-api.js";
import type {
  ManagedGenerationPreparation,
  ConsumerRestorationRecorder,
  ManagedRestorationAuthorityReader,
} from "../application-api.js";
import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import {
  assertRestorationImages,
  externalRestorationPath,
  restorationArtifacts,
  restorationConsumer,
  restorationGit,
  restorationInventory,
  retainRestorationProof,
} from "./node-consumer-restoration-evidence.js";
import { readRestorationEvidence } from "./node-consumer-restoration-selection.js";
import { allowedUpgradePaths } from "./node-consumer-upgrade-source-proof.js";
import { assertManagedRestorationEffects } from "./node-managed-restoration-scope.js";
import { INTEGRATION_PROFILE_PATH } from "./node-consumer-repository-files.js";

export function isCentralManagedAuthority(value: {
  readonly repository: unknown;
  readonly path: unknown;
}): boolean {
  return (
    value.repository === "agent-teams-ai/.github" &&
    value.path === "governance/docs-qualified-cohorts.json"
  );
}

export function assertManagedGenerations(source: unknown, target: unknown, reverse: boolean): void {
  requireRestoration(
    reverse ? source === 3 && target === 2 : source === 2 && target === 3,
    "explicit managed transition generations required.",
  );
}

export function assertManagedControllerRuntime(): void {
  requireRestoration(
    process.versions.node === "24.21.0",
    "externally retained controller requires actual Node24.21.0; no engine fallback.",
  );
}

export function parseManagedPreparation(
  bytes: Uint8Array,
  expect: string,
): ManagedGenerationPreparation {
  requireRestoration(
    bytes.length > 0 &&
      bytes.length <= MAXIMUM_RESTORATION_PROOF_BYTES &&
      /^sha256:[0-9a-f]{64}$/u.test(expect) &&
      sha256Bytes(bytes) === expect,
    "preparation differs from separately selected digest.",
  );
  const value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const wire = exactRestorationKeys(value, [
    "schemaVersion",
    "protocol",
    "sourceGeneration",
    "targetGeneration",
    "consumer",
    "sourceRevision",
    "sourceTree",
    "sourceInventoryDigest",
    "sourceCohort",
    "targetCohort",
    "controller",
    "kernel",
    "plan",
    "initialProofPath",
  ]);
  requireRestoration(
    wire["schemaVersion"] === 1 &&
      wire["sourceGeneration"] === 2 &&
      wire["targetGeneration"] === 3 &&
      wire["protocol"] === "agent-teams.managed-generation3-preparation/v1",
    "unsupported managed preparation family.",
  );
  const preparation = value as ManagedGenerationPreparation;
  assertRestorationIdentities(preparation);
  assertQualifiedDocsCohortBindingV2(preparation.sourceCohort);
  inverseManagedGenerationPlan(preparation.plan);
  requireRestoration(
    typeof preparation.initialProofPath === "string" &&
      preparation.initialProofPath.startsWith("/") &&
      preparation.initialProofPath.length <= 4096 &&
      `${restorationJson(value)}\n` === Buffer.from(bytes).toString("utf8"),
    "preparation must be canonical bounded inert JSON.",
  );
  return preparation;
}

export async function readManagedPreparation(root: string, path: string, expect: string) {
  const file = await readRestorationEvidence(root, path);
  requireRestoration(file.state === "file", "selected managed preparation is missing.");
  return parseManagedPreparation(file.bytes, expect);
}

async function historicalManagedProfile(root: string, revision: string) {
  const source = parseStrictJson(
    (await restorationGit(root, ["show", `${revision}:${INTEGRATION_PROFILE_PATH}`])).toString(
      "utf8",
    ),
  );
  await assertConsumerIntegrationProfileSchema(source);
  assertConsumerIntegrationDesiredStateV3(source);
  return source;
}

async function assertManagedPlanSource(root: string, preparation: ManagedGenerationPreparation) {
  const current = await historicalManagedProfile(root, preparation.sourceRevision);
  const desired = { ...current, schemaVersion: 4, cohort: preparation.targetCohort };
  assertManagedSuccessorProfileV4(desired);
  await assertConsumerIntegrationProfileSchema(desired);
  requireRestoration(
    restorationJson(current.cohort) === restorationJson(preparation.sourceCohort) &&
      restorationJson(current.repository) === restorationJson(preparation.consumer.repository),
    "historical source binding differs.",
  );
  const allowed = allowedUpgradePaths(current, true);
  const originals = new Map<string, Buffer>();
  const tracked = (
    await restorationGit(root, ["ls-tree", "-r", "--name-only", preparation.sourceRevision])
  )
    .toString()
    .split("\n");
  for (const path of allowed) {
    if (tracked.includes(path)) {
      originals.set(
        path,
        await restorationGit(root, ["show", `${preparation.sourceRevision}:${path}`]),
      );
    }
  }
  for (const operation of preparation.plan.operations) {
    requireRestoration(
      allowed.has(operation.path) &&
        operation.precondition.state === "known-file" &&
        operation.precondition.acceptedPreimages.length === 1,
      "plan exceeds finite managed replacements.",
    );
    const preimage = operation.precondition.acceptedPreimages[0]!;
    const mode = (
      await restorationGit(root, ["ls-tree", preparation.sourceRevision, "--", operation.path])
    )
      .toString()
      .split(" ")[0];
    requireRestoration(
      originals.get(operation.path)?.equals(Buffer.from(preimage.contentBase64, "base64")) ===
        true &&
        mode ===
          (preimage.mode === 0o644 ? "100644" : preimage.mode === 0o755 ? "100755" : "unsupported"),
      "preimage differs from exact immutable Git bytes/mode.",
    );
  }
  await assertManagedRestorationEffects({
    current,
    target: preparation.targetCohort,
    plan: preparation.plan,
    originals,
  });
  return current;
}

export async function assertManagedOriginalIntent(
  root: string,
  preparation: ManagedGenerationPreparation,
) {
  requireRestoration(
    (await restorationGit(root, ["rev-parse", `${preparation.sourceRevision}^{tree}`]))
      .toString()
      .trim() === preparation.sourceTree,
    "historical source tree changed.",
  );
  return assertManagedPlanSource(root, preparation);
}

export async function managedSourcePackageManager(
  root: string,
  preparation: ManagedGenerationPreparation,
): Promise<string> {
  const manifest = parseJsonRecord(
    (await restorationGit(root, ["show", `${preparation.sourceRevision}:package.json`])).toString(
      "utf8",
    ),
  );
  const manager = manifest["packageManager"];
  requireRestoration(
    typeof manager === "string",
    "selected exact source packageManager is missing.",
  );
  return manager;
}

/** Read-only binding checks usable while the caller already owns the mutation lease. */
export async function assertManagedPreparationSourceBinding(
  root: string,
  preparation: ManagedGenerationPreparation,
) {
  assertManagedControllerRuntime();
  requireRestoration(
    restorationJson(await restorationConsumer(root, preparation.consumer.repository)) ===
      restorationJson(preparation.consumer),
    "preparation belongs to another consumer.",
  );
  requireRestoration(
    restorationJson(await restorationArtifacts(root)) ===
      restorationJson({ controller: preparation.controller, kernel: preparation.kernel }),
    "retain the exact external controller and kernel builds.",
  );
  requireRestoration(
    (await restorationGit(root, ["rev-parse", "HEAD"])).toString().trim() ===
      preparation.sourceRevision &&
      (await restorationGit(root, ["rev-parse", `${preparation.sourceRevision}^{tree}`]))
        .toString()
        .trim() === preparation.sourceTree,
    "source Git revision/tree changed.",
  );
  return assertManagedPlanSource(root, preparation);
}

export async function assertManagedPreparationBinding(
  root: string,
  preparation: ManagedGenerationPreparation,
) {
  const current = await assertManagedPreparationSourceBinding(root, preparation);
  requireRestoration(
    (await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state === "idle",
    "recover active transaction with exact kernel first.",
  );
  return current;
}

export async function assertManagedRestorationAuthority(
  reader: ManagedRestorationAuthorityReader,
  preparation: ManagedGenerationPreparation,
) {
  const authority = await reader.readManagedRestoration({
    source: preparation.targetCohort,
    origin: preparation.sourceCohort,
    repository: preparation.consumer.repository,
  });
  requireRestoration(
    isCentralManagedAuthority(authority.target) &&
      /^(?!0{40}$)[0-9a-f]{40}$/u.test(authority.revision) &&
      authority.target.revision === authority.revision &&
      restorationJson(authority.target.cohort) === restorationJson(preparation.sourceCohort) &&
      preparation.targetCohort.upgradeFrom.includes(preparation.sourceCohort.cohortId) &&
      preparation.targetCohort.rollbackTo.includes(preparation.sourceCohort.cohortId),
    "fresh authority must retain exact supported original rollback edge.",
  );
  return authority;
}

export function managedRestorationRecorder(
  authority: ManagedRestorationAuthorityReader,
): NonNullable<ConsumerRestorationRecorder["prepareManaged"]> {
  return async (options) => {
    assertManagedControllerRuntime();
    const consumer = await restorationConsumer(options.consumerRoot, options.current.repository);
    const path = await externalRestorationPath(options.proofPath, consumer.root);
    requireRestoration(
      (await readRestorationEvidence(consumer.root, path, false)).state === "absent",
      "proof destination exists; preserve it.",
    );
    requireRestoration(
      (
        await restorationGit(consumer.root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          options.sourceRevision,
          "--",
        ])
      ).length === 0,
      "prepare requires unchanged committed source.",
    );
    const preparation: ManagedGenerationPreparation = {
      schemaVersion: 1,
      protocol: "agent-teams.managed-generation3-preparation/v1",
      sourceGeneration: 2,
      targetGeneration: 3,
      consumer,
      initialProofPath: path,
      sourceRevision: options.sourceRevision,
      sourceTree: (
        await restorationGit(consumer.root, ["rev-parse", `${options.sourceRevision}^{tree}`])
      )
        .toString()
        .trim(),
      sourceInventoryDigest: await restorationInventory(consumer.root),
      sourceCohort: options.current.cohort,
      targetCohort: options.target,
      ...(await restorationArtifacts(consumer.root)),
      plan: options.plan,
    };
    inverseManagedGenerationPlan(options.plan);
    const source = await assertManagedPreparationBinding(consumer.root, preparation);
    requireRestoration(
      restorationJson(source) === restorationJson(options.current),
      "current profile differs from Git source.",
    );
    await assertManagedRestorationAuthority(authority, preparation);
    await assertRestorationImages(consumer.root, preparation, true);
    parseManagedPreparation(
      Buffer.from(`${restorationJson(preparation)}\n`),
      sha256Bytes(Buffer.from(`${restorationJson(preparation)}\n`)),
    );
    return retainRestorationProof(
      await externalRestorationPath(`${path}.prepared`, consumer.root),
      preparation,
    );
  };
}
