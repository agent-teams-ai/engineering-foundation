import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { sourceCohort } from "./configuration.ts";
import { assertSourceIdentity, type SourceAdmission } from "./admission.ts";
import type { QualifiedTarget } from "./authority.ts";
import { AdoptionEvidence, invoke } from "./evidence.ts";
import {
  bytes,
  installedFiles,
  inventory,
  json,
  list,
  relativePath,
  selected,
  sha256,
  text,
} from "./files.ts";
import type { Prerequisites } from "./prerequisites.ts";

export interface ExpectedImage {
  readonly content: Buffer;
  readonly digest: string;
  readonly mode: number;
}
export interface PlanOperation {
  readonly path: string;
  readonly original: ExpectedImage;
  readonly target: ExpectedImage;
}
export interface Preparation {
  readonly path: string;
  readonly digest: string;
  readonly content: Buffer;
  readonly value: Row;
  readonly operations: readonly PlanOperation[];
}
export interface ProofContext {
  readonly evidence: AdoptionEvidence;
  readonly source: SourceAdmission;
  readonly target: QualifiedTarget;
  readonly prerequisites: Prerequisites;
  readonly kernel: Row;
  readonly builds: Row;
  readonly controllerBefore: Row;
  readonly completionPath: string;
}
function exactKeys(value: Row, keys: readonly string[]): void {
  assert.deepEqual(Object.keys(value).toSorted(), [...keys].toSorted());
}
function controllerObservation(evidence: AdoptionEvidence, prerequisites: Prerequisites): Row {
  const packages = prerequisites.controllerArchives.map((archive) => {
    const name = text(archive["name"], "Authenticated controller package");
    const root = join(prerequisites.controllerInstallation, "node_modules", name);
    return { name, files: installedFiles(root) };
  });
  return {
    packages,
    manifest: selected(join(prerequisites.controllerInstallation, "package.json")),
    lock: selected(join(prerequisites.controllerInstallation, "package-lock.json")),
    cli: selected(prerequisites.controllerCli),
    sourceRevision: evidence.config.sourceRevision,
  };
}
export async function createProofContext(
  evidence: AdoptionEvidence,
  source: SourceAdmission,
  target: QualifiedTarget,
  prerequisites: Prerequisites,
): Promise<ProofContext> {
  const require = createRequire(join(prerequisites.controllerInstallation, "package.json"));
  const kernel = row(
    await import(pathToFileURL(require.resolve("@agent-teams/repository-mutation")).href),
    "Authenticated public kernel",
  );
  const artifacts: Row[] = [];
  for (const [name, roots] of [
    ["@agent-teams/docs-protocol-agent-teams", ["dist", "assets", "schemas"]],
    ["@agent-teams/repository-mutation", ["dist", "schemas"]],
  ] as const) {
    const packageRoot = realpathSync(
      join(prerequisites.controllerInstallation, "node_modules", name),
    );
    const manifest = json(join(packageRoot, "package.json"));
    artifacts.push({
      name,
      version: manifest["version"],
      buildIdentity: await invoke(kernel, "computeInstalledArtifactBuildIdentity", [
        { packageRoot, roots },
      ]),
    });
  }
  const builds = { controller: artifacts[0]!, kernel: artifacts[1]! };
  evidence.record("actual-controller-build-identities", builds);
  const context = {
    evidence,
    source,
    target,
    prerequisites,
    kernel,
    builds,
    controllerBefore: controllerObservation(evidence, prerequisites),
    completionPath: join(evidence.operationRoot, "completion.json"),
  };
  evidence.record("controller-before-public-operations", context.controllerBefore);
  for (const path of [
    context.completionPath,
    context.completionPath + ".prepared",
    context.completionPath + ".receipt",
  ]) {
    assert(!existsSync(path), "Fresh external owner-produced proof paths required");
  }
  return context;
}
function expectedImage(value: unknown): ExpectedImage {
  const image = row(value, "Owner-produced known-file image");
  exactKeys(image, ["contentBase64", "digest", "mode", "size"]);
  const encoded = text(image["contentBase64"], "Known-file base64");
  const content = Buffer.from(encoded, "base64");
  assert.equal(content.toString("base64"), encoded);
  assert(content.length > 0 && content.length <= 8 * 1024 * 1024);
  assert.equal(content.length, image["size"]);
  assert.equal("sha256:" + sha256(content), image["digest"]);
  assert(image["mode"] === 0o644 || image["mode"] === 0o755);
  return { content, digest: text(image["digest"], "Known-file digest"), mode: image["mode"] };
}
function observedPlan(context: ProofContext, value: Row): PlanOperation[] {
  const plan = row(value["plan"], "Actual prepared plan");
  invoke(context.kernel, "assertKnownFileTransactionPlan", [plan]);
  const profile = context.source.profile;
  const allowed = new Set([
    "AGENTS.md",
    "architecture/foundation/docs-consumer-integration.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    relativePath(profile["skillPath"]),
    relativePath(profile["callerWorkflowPath"]),
    relativePath(profile["managedStatePath"]),
  ]);
  const operations = list(plan["operations"], "Actual managed operations").map((entry) => {
    const operation = row(entry, "Plan operation");
    const path = relativePath(operation["path"]);
    assert(
      allowed.has(path) && path !== ".node-version",
      "Unsupported managed path or same-pin write",
    );
    const precondition = row(operation["precondition"], "Original known-file precondition");
    assert.equal(precondition["state"], "known-file");
    const originals = list(precondition["acceptedPreimages"], "Original images");
    assert.equal(originals.length, 1);
    const original = expectedImage(originals[0]),
      target = expectedImage(operation["postimage"]);
    assert(bytes(join(context.evidence.config.consumer, path)).equals(original.content));
    const before = context.source.images.find((image) => image.path === path);
    assert(before && before.kind === "file");
    assert.equal(before.mode, original.mode);
    assert.equal("sha256:" + before.sha256, original.digest);
    assert.equal(original.mode, target.mode);
    return { path, original, target };
  });
  assert(operations.length > 0 && operations.length <= 8);
  assert.equal(new Set(operations.map((operation) => operation.path)).size, operations.length);
  return operations;
}
export function selectPreparation(context: ProofContext, envelope: Row): Preparation {
  const { evidence, source, target, kernel, builds, completionPath } = context;
  const selectedPreparation = row(envelope["preparation"], "Actual preparation selection");
  const path = text(selectedPreparation["path"], "Actual preparation path");
  assert.equal(path, completionPath + ".prepared");
  const content = bytes(path),
    digest = "sha256:" + sha256(content);
  assert.equal(selectedPreparation["digest"], digest);
  const value = row(JSON.parse(content.toString("utf8")), "Owner-produced preparation");
  exactKeys(value, [
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
  assert.equal(value["schemaVersion"], 1);
  assert.equal(value["protocol"], "agent-teams.managed-generation3-preparation/v1");
  assert.equal(value["sourceGeneration"], 2);
  assert.equal(value["targetGeneration"], 3);
  assert.equal(value["sourceRevision"], evidence.config.sourceRevision);
  assert.equal(value["sourceTree"], source.tree);
  assert.equal(value["initialProofPath"], completionPath);
  const { root, device, inode, birthtimeNs } = source.identity;
  assert.deepEqual(value["consumer"], {
    root,
    device,
    inode,
    birthtimeNs,
    repository: source.profile["repository"],
  });
  assert.deepEqual(value["sourceCohort"], source.profile["cohort"]);
  assert.equal(row(value["sourceCohort"], "Original cohort")["cohortId"], sourceCohort);
  assert.deepEqual(value["targetCohort"], target.binding);
  assert.deepEqual(value["controller"], builds["controller"]);
  assert.deepEqual(value["kernel"], builds["kernel"]);
  const inventoryInput = source.images.map((image) => {
    assert.equal(image.kind, "file", "Managed restoration admits regular source images");
    return { path: image.path, digest: "sha256:" + image.sha256, mode: image.mode };
  });
  assert.equal(value["sourceInventoryDigest"], invoke(kernel, "sha256Json", [inventoryInput]));
  const operations = observedPlan(context, value);
  assert.deepEqual(inventory(evidence.config.consumer), source.images);
  assertSourceIdentity(evidence, source, "after-prepare");
  assert(!existsSync(completionPath) && !existsSync(completionPath + ".receipt"));
  evidence.retain("actual-preparation.json", content);
  evidence.record("actual-preparation-selection", {
    path,
    digest,
    sourceRevision: evidence.config.sourceRevision,
    sourceTree: source.tree,
    managedPaths: operations.map((operation) => operation.path),
  });
  return { path, digest, content, value, operations };
}
export function assertReceipt(
  context: ProofContext,
  preparation: Preparation,
  value: unknown,
): Row {
  const receipt = row(value, "Actual applied receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "protocol",
    "planDigest",
    "outcome",
    "operations",
    "receiptDigest",
  ]);
  assert.equal(receipt["schemaVersion"], 1);
  assert.equal(receipt["protocol"], "agent-teams.repository-mutation.known-file/v1");
  assert.equal(
    receipt["planDigest"],
    row(preparation.value["plan"], "Prepared plan")["planDigest"],
  );
  assert.equal(
    receipt["outcome"],
    "applied",
    "Canonical first application requires authentic write ownership",
  );
  const operations = list(receipt["operations"], "Actual receipt operations").map((entry) =>
    row(entry, "Receipt operation"),
  );
  assert.equal(operations.length, preparation.operations.length);
  for (let index = 0; index < operations.length; index += 1) {
    const actual = operations[index]!,
      expected = preparation.operations[index]!;
    exactKeys(actual, ["path", "outcome", "resultDigest"]);
    assert.equal(actual["path"], expected.path);
    assert.equal(actual["outcome"], "replaced");
    assert.equal(actual["resultDigest"], expected.target.digest);
  }
  const { receiptDigest, ...body } = receipt;
  assert.equal(
    receiptDigest,
    invoke(context.kernel, "sha256Json", [
      { domain: "agent-teams.repository-mutation.known-file-receipt/v1", body },
    ]),
  );
  return receipt;
}
export function assertTargetImages(
  context: ProofContext,
  preparation: Preparation,
  label: string,
): void {
  const { evidence, source } = context;
  const after = inventory(evidence.config.consumer),
    managed = new Set(preparation.operations.map((operation) => operation.path));
  assert.deepEqual(
    after.filter((image) => !managed.has(image.path)),
    source.images.filter((image) => !managed.has(image.path)),
    "Complete foreign images changed",
  );
  for (const operation of preparation.operations) {
    const image = after.find((entry) => entry.path === operation.path);
    assert(image && image.kind === "file");
    assert.equal(image.mode, operation.target.mode);
    assert.equal("sha256:" + image.sha256, operation.target.digest);
    assert(bytes(join(evidence.config.consumer, operation.path)).equals(operation.target.content));
  }
  evidence.record(label + "-full-inventory", after);
  assertSourceIdentity(evidence, source, label);
  assert(bytes(preparation.path).equals(preparation.content), "Preparation changed");
  assert.deepEqual(
    selected(context.prerequisites.targetLock.path),
    context.prerequisites.targetLock,
  );
  assert.deepEqual(
    controllerObservation(evidence, context.prerequisites),
    context.controllerBefore,
  );
}
export function readCompletion(context: ProofContext, preparation: Preparation, envelope: Row) {
  const receipt = assertReceipt(context, preparation, envelope["receipt"]);
  const completionBytes = bytes(context.completionPath);
  const completion = row(JSON.parse(completionBytes.toString("utf8")), "Actual completion");
  exactKeys(completion, [
    "schemaVersion",
    "protocol",
    "preparationDigest",
    "receipt",
    "activation",
  ]);
  assert.equal(completion["schemaVersion"], 1);
  assert.equal(completion["protocol"], "agent-teams.managed-generation3-completion/v1");
  assert.equal(completion["preparationDigest"], preparation.digest);
  assert.equal(completion["activation"], "verified-current-v3");
  assert.deepEqual(completion["receipt"], receipt);
  const companionBytes = bytes(context.completionPath + ".receipt");
  const companion = row(JSON.parse(companionBytes.toString("utf8")), "Actual receipt companion");
  exactKeys(companion, ["preparationDigest", "receipt"]);
  assert.equal(companion["preparationDigest"], preparation.digest);
  assert.deepEqual(companion["receipt"], receipt);
  const restoration = row(envelope["restoration"], "Actual completion selection");
  assert.equal(restoration["path"], context.completionPath);
  assert.equal(restoration["digest"], "sha256:" + sha256(completionBytes));
  context.evidence.retain("actual-completion.json", completionBytes);
  context.evidence.retain("actual-receipt-companion.json", companionBytes);
  return { completionBytes, companionBytes, receipt, restoration };
}
export function assertInstalledTarget(context: ProofContext): string {
  const consumer = context.evidence.config.consumer;
  for (const archive of context.prerequisites.controllerArchives) {
    const name = text(archive["name"], "Target managed package");
    const root = realpathSync(join(consumer, "node_modules", name));
    const expected = json(
      text(row(archive["installedInventory"], "Authenticated inventory")["path"], "Inventory path"),
    );
    assert.deepEqual(
      installedFiles(root),
      expected["files"],
      "Actual installed target content differs from authenticated M archive",
    );
  }
  const cli = realpathSync(
    join(consumer, "node_modules/@agent-teams/docs-protocol-agent-teams/dist/cli.js"),
  );
  context.evidence.record("actual-installed-target-cli", selected(cli));
  return cli;
}
