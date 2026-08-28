import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  readlink,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

import type {
  KnownFileTransactionOperationInput
} from "@agent-teams/engineering-foundation/mutation";

import type {
  ConsumerUpgradeSandboxPort,
  PreparedConsumerUpgradeV1
} from "../application/ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerUpgradeAuthorityV1
} from "../domain/model.js";
import {
  projectConsumerIntegrationProfileV1,
  projectPnpmWorkspaceCohortExclusionsV1
} from "./consumer-upgrade-file-projectors.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  INTEGRATION_PROFILE_PATH,
  MAXIMUM_LOCKFILE_BYTES,
  MAXIMUM_MANAGED_ASSET_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  MAXIMUM_PROFILE_BYTES,
  MAXIMUM_WORKSPACE_BYTES,
  readStableConsumerFile
} from "./node-consumer-repository-files.js";
import {
  projectPnpmManifestCohortPinsV1
} from "./pnpm-manifest-adapter-v1.js";

const WORKSPACE_PATH = "pnpm-workspace.yaml";
const MAXIMUM_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_INVENTORY_FILES = 100_000;
const MAXIMUM_INVENTORY_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_INVENTORY_FILE_BYTES = 64 * 1024 * 1024;

interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface InventoryEntry {
  readonly digest: string;
  readonly kind: "file" | "symlink";
}

function execute(
  executable: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0]
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAXIMUM_PROCESS_OUTPUT_BYTES,
      signal: AbortSignal.timeout(10 * 60 * 1000),
      windowsHide: true
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : undefined;
      if (code !== undefined && allowedExitCodes.includes(code)) {
        resolve({ code, stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().slice(-4000);
      reject(new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_PROCESS_FAILED",
        `${executable} ${args[0] ?? ""} failed${detail === "" ? "." : `: ${detail}`}`,
        { cause: error ?? undefined }
      ));
    });
  });
}

async function assertCleanGitRoot(root: string): Promise<string> {
  const status = await execute(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root
  );
  if (status.stdout !== "") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_DIRTY_WORKTREE",
      "One-command Cohort upgrade requires a clean consumer Git worktree."
    );
  }
  const head = (await execute("git", ["rev-parse", "HEAD"], root)).stdout.trim();
  if (!/^(?!0{40}$)[0-9a-f]{40}$/u.test(head)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_GIT_INVALID",
      "Consumer worktree must have one exact Git HEAD."
    );
  }
  return head;
}

function contained(root: string, repositoryPath: string): string {
  const path = resolvePath(root, repositoryPath);
  const relation = relative(root, path);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PATH_ESCAPE",
      `Upgrade path escapes the disposable repository: ${repositoryPath}.`
    );
  }
  return path;
}

async function writeProjectedFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const target = contained(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function runPnpm(root: string, args: readonly string[]): Promise<void> {
  await execute("corepack", ["pnpm", ...args], root);
}

function parseConsumerExecution(result: ProcessResult): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
      "Target Docs Protocol CLI did not return one JSON execution envelope."
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
      "Target Docs Protocol CLI returned an invalid execution envelope."
    );
  }
  return parsed as Record<string, unknown>;
}

async function invokeInstalledDocs(
  root: string,
  args: readonly string[]
): Promise<Record<string, unknown>> {
  const cli = join(
    root,
    "node_modules",
    "@agent-teams",
    "docs-protocol",
    "dist",
    "cli.js"
  );
  const metadata = await lstat(cli);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
      "Installed target Docs Protocol CLI is not one regular package file."
    );
  }
  const result = await execute(
    process.execPath,
    [cli, "consumer", ...args, "--consumer", root, "--json"],
    root,
    [0, 1]
  );
  return parseConsumerExecution(result);
}

async function applyTargetIntegration(root: string, cohortId: string): Promise<void> {
  const plan = await invokeInstalledDocs(root, ["plan", "--to", cohortId]);
  if (plan["outcome"] === "change-required") {
    const planValue = plan["plan"];
    const digest = typeof planValue === "object" && planValue !== null &&
      !Array.isArray(planValue) ? (planValue as Record<string, unknown>)["planDigest"] : undefined;
    if (typeof digest !== "string") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_TARGET_INVALID",
        "Target Docs Protocol Plan did not expose one exact digest."
      );
    }
    const applied = await invokeInstalledDocs(root, ["apply", "--expect", digest]);
    if (!(["applied", "current"] as const).includes(
      applied["outcome"] as "applied" | "current"
    )) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_TARGET_BLOCKED",
        "Target Docs Protocol apply did not converge in the disposable repository."
      );
    }
  } else if (plan["outcome"] !== "current") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_BLOCKED",
      "Target Docs Protocol rejected the projected Cohort in the disposable repository."
    );
  }
  await assertInstalledIntegrationCurrent(root);
}

async function assertInstalledIntegrationCurrent(root: string): Promise<void> {
  const checked = await invokeInstalledDocs(root, ["check"]);
  if (checked["outcome"] !== "current") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_TARGET_BLOCKED",
      "Target Docs Protocol check did not converge in the disposable repository."
    );
  }
}

function ignoredInventoryPath(prefix: string, name: string): boolean {
  return name === "node_modules" ||
    (prefix === "" && (name === ".git" || name === ".agent-teams-local"));
}

async function repositoryInventory(root: string): Promise<Map<string, InventoryEntry>> {
  const output = new Map<string, InventoryEntry>();
  let totalBytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )) {
      if (ignoredInventoryPath(prefix, entry.name)) {continue;}
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      if (output.size >= MAXIMUM_INVENTORY_FILES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded file count."
        );
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        output.set(path, {
          kind: "symlink",
          digest: createHash("sha256").update(target).digest("hex")
        });
        continue;
      }
      if (!entry.isFile()) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_INPUT_INVALID",
          `Disposable consumer contains unsupported filesystem evidence: ${path}.`
        );
      }
      const metadata = await lstat(absolute);
      if (metadata.size > MAXIMUM_INVENTORY_FILE_BYTES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          `Disposable consumer file exceeds the inventory limit: ${path}.`
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > MAXIMUM_INVENTORY_BYTES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded byte count."
        );
      }
      output.set(path, {
        kind: "file",
        digest: createHash("sha256").update(await readFile(absolute)).digest("hex")
      });
    }
  }
  await visit(root, "");
  return output;
}

function changedInventoryPaths(
  before: ReadonlyMap<string, InventoryEntry>,
  after: ReadonlyMap<string, InventoryEntry>
): readonly string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => {
    const left = before.get(path);
    const right = after.get(path);
    return left?.kind !== right?.kind || left?.digest !== right?.digest;
  }).toSorted();
}

function maximumBytes(path: string): number {
  if (path === INTEGRATION_PROFILE_PATH) {return MAXIMUM_PROFILE_BYTES;}
  if (path === "package.json") {return MAXIMUM_MANIFEST_BYTES;}
  if (path === "pnpm-lock.yaml") {return MAXIMUM_LOCKFILE_BYTES;}
  if (path === WORKSPACE_PATH) {return MAXIMUM_WORKSPACE_BYTES;}
  return MAXIMUM_MANAGED_ASSET_BYTES;
}

function allowedUpgradePaths(current: ConsumerIntegrationDesiredStateV1): ReadonlySet<string> {
  return new Set([
    "AGENTS.md",
    INTEGRATION_PROFILE_PATH,
    "package.json",
    "pnpm-lock.yaml",
    WORKSPACE_PATH,
    current.skillPath,
    current.callerWorkflowPath,
    current.managedStatePath
  ]);
}

async function operationForChangedPath(input: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly stagedRoot: string;
}): Promise<KnownFileTransactionOperationInput> {
  const [preimage, postimage] = await Promise.all([
    readStableConsumerFile(input.consumerRoot, input.path, maximumBytes(input.path), true),
    readStableConsumerFile(input.stagedRoot, input.path, maximumBytes(input.path), true)
  ]);
  if (preimage.state !== "file" || postimage.state !== "file") {throw new Error("unreachable");}
  return Object.freeze({
    path: input.path,
    precondition: {
      state: "known-file" as const,
      acceptedPreimages: [{ bytes: preimage.bytes, mode: preimage.mode }]
    },
    postimage: { bytes: postimage.bytes, mode: preimage.mode }
  });
}

async function extractHead(root: string, head: string, target: string): Promise<void> {
  const archive = `${target}.tar`;
  await execute("git", ["archive", "--format=tar", `--output=${archive}`, head], root);
  await mkdir(target, { recursive: true });
  await execute("tar", ["-xf", archive, "-C", target], root);
  await rm(archive, { force: true });
}

async function installCohort(root: string, offline: boolean): Promise<void> {
  await runPnpm(root, [
    "install",
    offline ? "--offline" : "--prefer-offline",
    offline ? "--frozen-lockfile" : "--no-frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--verify-store-integrity"
  ]);
}

export class NodeConsumerUpgradeSandbox implements ConsumerUpgradeSandboxPort {
  public async prepare(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
  }): Promise<PreparedConsumerUpgradeV1> {
    const head = await assertCleanGitRoot(options.consumerRoot);
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "docs-consumer-upgrade-"))
    );
    const beforeRoot = join(temporary, "before");
    const stagedRoot = join(temporary, "staged");
    try {
      await Promise.all([
        extractHead(options.consumerRoot, head, beforeRoot),
        extractHead(options.consumerRoot, head, stagedRoot)
      ]);
      await execute("git", ["init", "-q"], stagedRoot);
      const [profile, manifest] = await Promise.all([
        readStableConsumerFile(stagedRoot, INTEGRATION_PROFILE_PATH, MAXIMUM_PROFILE_BYTES, true),
        readStableConsumerFile(stagedRoot, "package.json", MAXIMUM_MANIFEST_BYTES, true)
      ]);
      if (profile.state !== "file" || manifest.state !== "file") {throw new Error("unreachable");}
      await Promise.all([
        writeProjectedFile(stagedRoot, INTEGRATION_PROFILE_PATH,
          await projectConsumerIntegrationProfileV1({
            bytes: profile.bytes,
            cohort: options.authority.cohort
          })),
        writeProjectedFile(stagedRoot, "package.json", projectPnpmManifestCohortPinsV1({
          bytes: manifest.bytes,
          cohort: options.authority.cohort
        }))
      ]);
      const workspace = await readStableConsumerFile(
        stagedRoot,
        WORKSPACE_PATH,
        MAXIMUM_WORKSPACE_BYTES,
        false
      );
      if (workspace.state === "file") {
        await writeProjectedFile(
          stagedRoot,
          WORKSPACE_PATH,
          projectPnpmWorkspaceCohortExclusionsV1({
            bytes: workspace.bytes,
            cohort: options.authority.cohort
          })
        );
      }
      await installCohort(stagedRoot, false);
      await applyTargetIntegration(stagedRoot, options.authority.cohort.cohortId);
      const changed = changedInventoryPaths(
        await repositoryInventory(beforeRoot),
        await repositoryInventory(stagedRoot)
      );
      const allowed = allowedUpgradePaths(options.current);
      const unexpected = changed.filter((path) => !allowed.has(path));
      if (unexpected.length > 0) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_SCOPE_VIOLATION",
          `Disposable upgrade changed paths outside its closed inventory: ${unexpected.slice(0, 8).join(", ")}.`
        );
      }
      if (changed.includes(WORKSPACE_PATH) &&
        (await readStableConsumerFile(options.consumerRoot, WORKSPACE_PATH, MAXIMUM_WORKSPACE_BYTES, false))
          .state === "absent") {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_SCOPE_VIOLATION",
          "Cohort upgrade cannot introduce a previously absent pnpm workspace authority."
        );
      }
      await assertCleanGitRoot(options.consumerRoot);
      const operations = await Promise.all(changed.map((path) => operationForChangedPath({
        consumerRoot: options.consumerRoot,
        path,
        stagedRoot
      })));
      return Object.freeze({ operations: Object.freeze(operations) });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  public async activateAndVerify(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
  }): Promise<void> {
    await installCohort(options.consumerRoot, true);
    await assertInstalledIntegrationCurrent(options.consumerRoot);
  }

  public async restoreAndVerify(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
  }): Promise<void> {
    await installCohort(options.consumerRoot, true);
    await assertInstalledIntegrationCurrent(options.consumerRoot);
  }
}

export const nodeConsumerUpgradeSandbox: ConsumerUpgradeSandboxPort =
  Object.freeze(new NodeConsumerUpgradeSandbox());
