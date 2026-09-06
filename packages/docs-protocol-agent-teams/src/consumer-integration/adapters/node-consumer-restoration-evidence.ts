import { execFile } from "node:child_process";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeInstalledArtifactBuildIdentity, sha256Bytes, sha256Json,
  type KnownFileTransactionPlanV1, type KnownFileImageV1
} from "@agent-teams/repository-mutation";
import type { ConsumerIntegrationDesiredStateV1, QualifiedDocsCohortBindingV2 } from "../domain/model.js";
import {
  type ConsumerRestorationIntent,
  MAXIMUM_RESTORATION_PROOF_BYTES,
  requireRestoration,
  restorationJson,
  assertConsumerIntegrationDesiredStateV1
} from "../application-api.js";


import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import {
  canonicalConsumerRoot, INTEGRATION_PROFILE_PATH, readStableConsumerFile
} from "./node-consumer-repository-files.js";
import { assertRestorationManagedEffects } from "./node-consumer-restoration-scope.js";
import { allowedUpgradePaths } from "./node-consumer-upgrade-source-proof.js";
import { assertGitHubRuntimeIdentity } from "./node-consumer-integration-repository.js";
import { parseJsonRecord } from "./strict-json-record.js";

const controllerRoot = fileURLToPath(new URL("../../../", import.meta.url));
const kernelRoot = dirname(fileURLToPath(import.meta.resolve("@agent-teams/repository-mutation/package.json")));

export function restorationGit(root: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {execFile("git", ["--no-replace-objects", ...args], {
    cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000, windowsHide: true
  }, (error, stdout) => {if (error === null) {resolve(stdout);} else {reject(error);}});});
}

export async function restorationArtifacts(root: string) {
  const artifacts = [];
  for (const [path, name, roots] of [
    [controllerRoot, "@agent-teams/docs-protocol-agent-teams", ["dist", "assets", "schemas"]],
    [kernelRoot, "@agent-teams/repository-mutation", ["dist", "schemas"]]
  ] as const) {
    const canonical = await realpath(path);
    const relation = relative(root, canonical);
    requireRestoration(relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation),
      "retain the controller and its kernel outside the consumer being replaced.");
    const manifest = await readStableConsumerFile(canonical, "package.json", 1024 * 1024, true);
    requireRestoration(manifest.state === "file", "artifact manifest is missing.");
    const parsed = parseJsonRecord(Buffer.from(manifest.bytes).toString("utf8"));
    requireRestoration(parsed["name"] === name && typeof parsed["version"] === "string",
      "unexpected installed artifact.");
    artifacts.push({ name, version: parsed["version"], buildIdentity:
      await computeInstalledArtifactBuildIdentity({ packageRoot: canonical, roots }) });
  }
  return { controller: artifacts[0]!, kernel: artifacts[1]! };
}

export async function restorationConsumer(rootInput: string, repository: ConsumerIntegrationDesiredStateV1["repository"]) {
  const root = await canonicalConsumerRoot(rootInput);
  requireRestoration(root === resolvePath(rootInput), "consumer root must be canonical without aliases.");
  requireRestoration((await restorationGit(root, ["rev-parse", "--show-toplevel"])).toString().trim() === root,
    "consumer must be the exact Git top-level directory.");
  assertGitHubRuntimeIdentity({ repository });
  const stat = await lstat(root, { bigint: true });
  return { root, device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), repository };
}

export async function historicalRestorationProfile(root: string, revision: string): Promise<ConsumerIntegrationDesiredStateV1> {
  const bytes = await restorationGit(root, ["show", `${revision}:${INTEGRATION_PROFILE_PATH}`]);
  const parsed = parseJsonRecord(bytes.toString("utf8"));
  await assertConsumerIntegrationProfileSchema(parsed);
  requireRestoration(parsed["schemaVersion"] === 1 || parsed["schemaVersion"] === 2,
    "recorded source must be an explicit historical profile.");
  const { qualification: _qualification, ...source } = parsed;
  const desired = { ...source, schemaVersion: 1 } as unknown as ConsumerIntegrationDesiredStateV1;
  assertConsumerIntegrationDesiredStateV1(desired);
  return desired;
}

export async function assertRestorationPlanSource(root: string, revision: string,
  current: ConsumerIntegrationDesiredStateV1, plan: KnownFileTransactionPlanV1, target: QualifiedDocsCohortBindingV2): Promise<void> {
  const allowed = allowedUpgradePaths(current);
  requireRestoration(plan.operations.some(({ path }) => path === INTEGRATION_PROFILE_PATH) &&
    plan.operations.some(({ path }) => path === "package.json") &&
    plan.operations.some(({ path }) => path === "pnpm-lock.yaml"), "migration lacks its profile/manifest/lock replacements.");
  for (const operation of plan.operations) {
    requireRestoration(allowed.has(operation.path) && operation.precondition.state === "known-file" &&
      operation.precondition.acceptedPreimages.length === 1, "original plan exceeds the closed managed replacement set.");
    const original = await restorationGit(root, ["show", `${revision}:${operation.path}`]);
    const mode = (await restorationGit(root, ["ls-tree", revision, "--", operation.path])).toString().split(" ")[0];
    const preimage = operation.precondition.acceptedPreimages[0]!;
    requireRestoration(original.equals(Buffer.from(preimage.contentBase64, "base64")) &&
      mode === (preimage.mode === 0o644 ? "100644" : preimage.mode === 0o755 ? "100755" : "unsupported"), "preimage differs from immutable source Git evidence.");
  }
  const originals = new Map<string, Buffer>();
  const tracked = (await restorationGit(root, ["ls-tree", "-r", "--name-only", revision])).toString().split("\n");
  for (const path of allowed) {
    if (tracked.includes(path)) {originals.set(path, await restorationGit(root, ["show", `${revision}:${path}`]));}
  }
  await assertRestorationManagedEffects({ current, target, plan, originals });
}

// Observe every repository file, including ignored files, except installation and kernel state.
// Substituting only proved operation images permits comparison with the exact original inventory.
export async function restorationInventory(root: string, substitutes = new Map<string, KnownFileImageV1>()): Promise<`sha256:${string}`> {
  const entries: { path: string; digest: `sha256:${string}`; mode: number }[] = [];
  let total = 0;
  let visited = 0;
  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    requireRestoration(depth <= 64, "repository inventory is too deep.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      requireRestoration(++visited <= 100_000, "repository inventory is too large.");
      if (entry.name === "node_modules" || (prefix === "" && [".git", ".agent-teams-local"].includes(entry.name))) {continue;}
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {await walk(join(directory, entry.name), path, depth + 1); continue;}
      requireRestoration(entry.isFile(), "repository inventory contains symlink or special-file evidence.");
      const observation = await readStableConsumerFile(root, path, 64 * 1024 * 1024, true);
      requireRestoration(observation.state === "file", "missing inventory file.");
      total += observation.bytes.byteLength;
      requireRestoration(total <= 1024 * 1024 * 1024, "repository inventory exceeds byte limit.");
      const substitute = substitutes.get(path);
      entries.push({ path, digest: substitute?.digest ?? sha256Bytes(observation.bytes), mode: substitute?.mode ?? observation.mode });
    }
  }
  await walk(root, "", 0);
  return sha256Json(entries.toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export async function assertRestorationImages(root: string, proof: ConsumerRestorationIntent, historical: boolean): Promise<void> {
  const originalImages = new Map<string, KnownFileImageV1>();
  for (const operation of proof.plan.operations) {
    requireRestoration(operation.precondition.state === "known-file", "replacement preimage required.");
    const original = operation.precondition.acceptedPreimages[0]!;
    const expected = historical ? original : operation.postimage;
    const observed = await readStableConsumerFile(root, operation.path, 8 * 1024 * 1024, true);
    requireRestoration(observed.state === "file" && observed.mode === expected.mode && sha256Bytes(observed.bytes) === expected.digest,
      `current bytes or mode differ at ${operation.path}.`);
    originalImages.set(operation.path, original);
  }
  requireRestoration(await restorationInventory(root, originalImages) === proof.sourceInventoryDigest,
    "repository contains unrelated edits, missing files or mode changes.");
}

export async function externalRestorationPath(path: string, consumerRoot: string): Promise<string> {
  requireRestoration(isAbsolute(path) && path.length <= 4096, "proof path must be absolute and bounded.");
  const parent = await realpath(dirname(path));
  const absolute = resolvePath(path);
  requireRestoration(join(parent, absolute.slice(dirname(absolute).length + 1)) === absolute,
    "proof path must have canonical parents.");
  for (const forbidden of [consumerRoot, await realpath(controllerRoot), await realpath(kernelRoot)]) {
    const relation = relative(forbidden, absolute);
    requireRestoration(relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation),
      "proof must be retained outside the consumer and controller install trees.");
  }
  return absolute;
}

export async function retainRestorationProof(path: string, proof: unknown) {
  const bytes = Buffer.from(`${restorationJson(proof)}\n`);
  requireRestoration(bytes.length <= MAXIMUM_RESTORATION_PROOF_BYTES, "proof exceeds byte limit.");
  const file = await open(path, "wx", 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  const parent = await open(dirname(path), "r");
  try {await parent.sync();} finally {await parent.close();}
  return { path, digest: sha256Bytes(bytes) };
}

// A complete write may have survived a kill before its sync or before result output.
export async function syncRestorationProof(path: string): Promise<void> {
  const file = await open(path, "r");
  try {await file.sync();} finally {await file.close();}
  const parent = await open(dirname(path), "r");
  try {await parent.sync();} finally {await parent.close();}
}
