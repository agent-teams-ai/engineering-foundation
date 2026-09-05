import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
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
} from "@agent-teams/repository-mutation";

import type {
  ConsumerUpgradeManagedPreimagesV2,
  ConsumerUpgradeSandboxPort,
  PreparedConsumerUpgradeV1
} from "../application/ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationSnapshot,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2
} from "../domain/model.js";
import {
  projectConsumerUpgradeFiles
} from "./consumer-upgrade-file-projectors.js";
import {
  extractHead,
  MAXIMUM_INVENTORY_BYTES,
  MAXIMUM_INVENTORY_FILE_BYTES,
  MAXIMUM_INVENTORY_FILES
} from "./node-consumer-upgrade-archive.js";
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
  applyTargetIntegration,
  assertInstalledHistoricalIntegrationCurrent,
  assertInstalledIntegrationCurrent
} from "./node-consumer-upgrade-target.js";
import {
  allowedUpgradePaths,
  assertCleanConsumerGitSource,
  assertManagedAssetsCreatedV2,
  assertProvedSourceSnapshot,
  resetProvedManagedAssetsV2
} from "./node-consumer-upgrade-source-proof.js";
type ConsumerUpgradeAuthority = ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2;
type UpgradeDesiredState = ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3;

function isAuthorityV1(value: ConsumerUpgradeAuthority): value is ConsumerUpgradeAuthorityV1 {
  return value.cohort.schemaVersion === 1;
}

const WORKSPACE_PATH = "pnpm-workspace.yaml";
const MAXIMUM_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
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

const assertCleanGitRoot = (root: string): Promise<string> =>
  assertCleanConsumerGitSource(root, execute);

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
      const observation = await readStableConsumerFile(
        root,
        path,
        MAXIMUM_INVENTORY_FILE_BYTES,
        true
      );
      if (observation.state !== "file") {throw new Error("unreachable");}
      totalBytes += observation.bytes.byteLength;
      if (totalBytes > MAXIMUM_INVENTORY_BYTES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded byte count."
        );
      }
      output.set(path, {
        kind: "file",
        digest: createHash("sha256").update(observation.bytes).digest("hex")
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

async function operationForChangedPath(input: {
  readonly sourceRoot: string;
  readonly path: string;
  readonly stagedRoot: string;
}): Promise<KnownFileTransactionOperationInput> {
  const [preimage, postimage] = await Promise.all([
    readStableConsumerFile(input.sourceRoot, input.path, maximumBytes(input.path), true),
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
  private async prepareGeneration(options: {
    readonly authority: ConsumerUpgradeAuthority;
    readonly consumerRoot: string;
    readonly current: UpgradeDesiredState;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
    readonly managedPreimages?: ConsumerUpgradeManagedPreimagesV2;
  }): Promise<PreparedConsumerUpgradeV1> {
    const head = await assertCleanGitRoot(options.consumerRoot);
    if (head !== options.expectedSourceRevision) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
        "Consumer Git HEAD changed after the source Cohort was proved current."
      );
    }
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "docs-consumer-upgrade-"))
    );
    const beforeRoot = join(temporary, "before");
    const stagedRoot = join(temporary, "staged");
    try {
      await Promise.all([
        extractHead({ root: options.consumerRoot, head, target: beforeRoot }, execute),
        extractHead({ root: options.consumerRoot, head, target: stagedRoot }, execute)
      ]);
      await assertProvedSourceSnapshot({
        current: options.current,
        expected: options.expectedSourceSnapshot,
        sourceRoot: beforeRoot
      });
      await execute("git", ["init", "-q"], stagedRoot);
      const [profile, manifest] = await Promise.all([
        readStableConsumerFile(stagedRoot, INTEGRATION_PROFILE_PATH, MAXIMUM_PROFILE_BYTES, true),
        readStableConsumerFile(stagedRoot, "package.json", MAXIMUM_MANIFEST_BYTES, true)
      ]);
      if (profile.state !== "file" || manifest.state !== "file") {throw new Error("unreachable");}
      const workspace = await readStableConsumerFile(
        stagedRoot,
        WORKSPACE_PATH,
        MAXIMUM_WORKSPACE_BYTES,
        false
      );
      const fileInput = {
        profile: profile.bytes,
        manifest: manifest.bytes,
        ...(workspace.state === "file" ? { workspace: workspace.bytes } : {})
      };
      let projected;
      if (options.current.schemaVersion === 1 && isAuthorityV1(options.authority)) {
        projected = await projectConsumerUpgradeFiles({
          ...fileInput,
          authority: options.authority,
          current: options.current
        });
      } else if (!isAuthorityV1(options.authority)) {
        projected = options.current.schemaVersion === 1
          ? await projectConsumerUpgradeFiles({
              ...fileInput, authority: options.authority, current: options.current
            })
          : await projectConsumerUpgradeFiles({
              ...fileInput, authority: options.authority, current: options.current
            });
      } else {throw new Error("unreachable");}
      await Promise.all([
        writeProjectedFile(stagedRoot, INTEGRATION_PROFILE_PATH, projected.profile),
        writeProjectedFile(stagedRoot, "package.json", projected.manifest),
        ...(projected.migrationWorkspace === undefined ? [] : [
          writeProjectedFile(stagedRoot, WORKSPACE_PATH, projected.migrationWorkspace)
        ])
      ]);
      await installCohort(stagedRoot, false);
      if (projected.targetWorkspace !== undefined) {
        await writeProjectedFile(stagedRoot, WORKSPACE_PATH, projected.targetWorkspace);
      }
      if (options.current.schemaVersion === 3) {
        if (options.managedPreimages === undefined) {throw new Error("unreachable");}
        await resetProvedManagedAssetsV2({
          current: options.current,
          managedPreimages: options.managedPreimages,
          stagedRoot
        });
      } else if (!isAuthorityV1(options.authority)) {
        await Promise.all([
          options.current.callerWorkflowPath,
          options.current.managedStatePath,
          options.current.skillPath
        ].map((path) => rm(contained(stagedRoot, path))));
      }
      await applyTargetIntegration(stagedRoot, options.authority.cohort.cohortId, execute);
      if (!isAuthorityV1(options.authority)) {
        await assertManagedAssetsCreatedV2(stagedRoot, options.current);
      }
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
      if (await assertCleanGitRoot(options.consumerRoot) !== head) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
          "Consumer Git HEAD changed while the successor was staged."
        );
      }
      const operations = await Promise.all(changed.map((path) => operationForChangedPath({
        path,
        sourceRoot: beforeRoot,
        stagedRoot
      })));
      return Object.freeze({ operations: Object.freeze(operations) });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  public prepareV1(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  }): Promise<PreparedConsumerUpgradeV1> {
    return this.prepareGeneration(options);
  }

  public prepareV2(options: {
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
    readonly managedPreimages: ConsumerUpgradeManagedPreimagesV2;
  }): Promise<PreparedConsumerUpgradeV1> {
    return this.prepareGeneration(options);
  }

  public prepareV1ToV2(options: {
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  }): Promise<PreparedConsumerUpgradeV1> {
    return this.prepareGeneration(options);
  }

  private async activateAndVerifyGeneration(options: {
    readonly authority: ConsumerUpgradeAuthority;
    readonly consumerRoot: string;
  }): Promise<void> {
    await installCohort(options.consumerRoot, true);
    await assertInstalledIntegrationCurrent(options.consumerRoot, execute);
  }

  public activateAndVerifyV1(options: {
    readonly authority: ConsumerUpgradeAuthorityV1;
    readonly consumerRoot: string;
  }): Promise<void> {
    return this.activateAndVerifyGeneration(options);
  }

  public activateAndVerifyV2(options: {
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
  }): Promise<void> {
    return this.activateAndVerifyGeneration(options);
  }

  private async restoreAndVerifyGeneration(options: {
    readonly consumerRoot: string;
    readonly current: UpgradeDesiredState;
  }): Promise<void> {
    await installCohort(options.consumerRoot, true);
    if (options.current.schemaVersion === 1) {
      await assertInstalledHistoricalIntegrationCurrent(options.consumerRoot, execute);
    } else {
      await assertInstalledIntegrationCurrent(options.consumerRoot, execute);
    }
  }

  public restoreAndVerifyV1(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
  }): Promise<void> {
    return this.restoreAndVerifyGeneration(options);
  }

  public async restoreAndVerifyV2(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
  }): Promise<void> {
    await assertCleanGitRoot(options.consumerRoot);
    await this.restoreAndVerifyGeneration(options);
    await assertCleanGitRoot(options.consumerRoot);
  }
}

export const nodeConsumerUpgradeSandbox: ConsumerUpgradeSandboxPort =
  Object.freeze(new NodeConsumerUpgradeSandbox());
