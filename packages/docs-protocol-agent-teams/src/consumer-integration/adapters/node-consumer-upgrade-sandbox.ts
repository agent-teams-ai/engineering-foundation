import { assertCapturedConsumerTargetLockfile, validateConsumerTargetLockfile, verifyConsumerTargetLockfile } from "./node-consumer-target-lockfile.js";
import { consumerProcessEnvironment } from "./node-consumer-environment.js";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

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
  ConsumerUpgradeAuthorityV2,
  ConsumerUpgradeAuthorityV3,
  ManagedSuccessorSelectionV3
} from "../domain/model.js";
import {
  projectConsumerUpgradeFiles,
  type ConsumerUpgradeFileProjection
} from "./consumer-upgrade-file-projectors.js";
import { extractHead } from "./node-consumer-upgrade-archive.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  INTEGRATION_PROFILE_PATH,
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
import {
  changedInventoryPaths,
  operationForChangedPath,
  repositoryInventory,
  WORKSPACE_PATH
} from "./node-consumer-upgrade-sandbox-inventory-internal.js";
type ConsumerUpgradeAuthority = ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2 |
  ConsumerUpgradeAuthorityV3;
type UpgradeDesiredState = ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3;
type UpgradeFileInput = {
  readonly manifest: Uint8Array;
  readonly profile: Uint8Array;
  readonly workspace?: Uint8Array;
};
type PrepareGenerationOptions = {
  readonly selectedLock?: Uint8Array;
  readonly authority: ConsumerUpgradeAuthority;
  readonly consumerRoot: string;
  readonly current: UpgradeDesiredState;
  readonly expectedSourceRevision: string;
  readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  readonly managedPreimages?: ConsumerUpgradeManagedPreimagesV2;
  readonly selection?: ManagedSuccessorSelectionV3;
};

function isAuthorityV1(value: ConsumerUpgradeAuthority): value is ConsumerUpgradeAuthorityV1 {
  return value.cohort.schemaVersion === 1;
}

function isAuthorityV3(value: ConsumerUpgradeAuthority): value is ConsumerUpgradeAuthorityV3 {
  return value.cohort.schemaVersion === 3;
}

function isAuthorityV2(value: ConsumerUpgradeAuthority): value is ConsumerUpgradeAuthorityV2 {
  return value.cohort.schemaVersion === 2;
}

const MAXIMUM_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}
function execute(
  executable: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
  environment?: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      cwd,
      ...(environment === undefined ? {} : { env: environment }),
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

async function runPnpm(root: string, args: readonly string[], environment: () => NodeJS.ProcessEnv): Promise<void> {
  await execute("corepack", ["pnpm", ...args], root, [0], args.includes("--offline")
    ? { ...environment(), COREPACK_ENABLE_NETWORK: "0" } : undefined);
}


async function installCohort(root: string, offline: boolean, environment: () => NodeJS.ProcessEnv, frozen = offline): Promise<void> {
  // pnpm skips existing imports even in copy mode. Keep the prior installation
  // until a fresh import succeeds; --force also bypasses package installability.
  // This backup is not journaled: interruption leaves evidence for manual recovery.
  const backup = await mkdtemp(join(root, ".docs-consumer-upgrade-modules-"));
  const modules = join(root, "node_modules");
  const priorModules = join(backup, "node_modules");
  let moved = false;
  try {
    await rename(modules, priorModules);
    moved = true;
  } catch (error) {
    await rm(backup, { recursive: true, force: true });
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {throw error;}
  }
  try {
    await runPnpm(root, [
      "install",
      offline ? "--offline" : "--prefer-offline",
      frozen ? "--frozen-lockfile" : "--no-frozen-lockfile",
      "--package-import-method=copy",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--verify-store-integrity"
    ], environment);
  } catch (error) {
    try {
      if (moved) {
        await rm(modules, { recursive: true, force: true });
        await rename(priorModules, modules);
      }
      await rm(backup, { recursive: true, force: true });
    } catch (restoreError) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_PROCESS_FAILED",
        `Installation failed and prior modules could not be restored; preserve ${backup} for manual recovery.`,
        { cause: new AggregateError([error, restoreError], "Installation and modules restoration failed.") }
      );
    }
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

export class NodeConsumerUpgradeSandbox implements ConsumerUpgradeSandboxPort {
  readonly #environment: () => NodeJS.ProcessEnv;

  public constructor(environment: () => NodeJS.ProcessEnv = consumerProcessEnvironment) {
    this.#environment = environment;
  }

  private async prepareGeneration(options: PrepareGenerationOptions): Promise<PreparedConsumerUpgradeV1> {
    const { selectedLock } = options;
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
      const projected = await this.projectGenerationFiles(options, fileInput);
      const validatedLock = await validateConsumerTargetLockfile(
        selectedLock, projected.profile, options.current, beforeRoot
      );
      await Promise.all([
        writeProjectedFile(stagedRoot, INTEGRATION_PROFILE_PATH, projected.profile),
        writeProjectedFile(stagedRoot, "package.json", projected.manifest),
        ...(projected.nodeVersion === undefined ? [] : [
          writeProjectedFile(stagedRoot, ".node-version", projected.nodeVersion)
        ]),
        ...(projected.migrationWorkspace === undefined ? [] : [
          writeProjectedFile(stagedRoot, WORKSPACE_PATH, projected.migrationWorkspace)
        ])
      ]);
      if (selectedLock !== undefined) {
        await writeProjectedFile(stagedRoot, "pnpm-lock.yaml", selectedLock);
      }
      await installCohort(stagedRoot, false, this.#environment, selectedLock !== undefined);
      await verifyConsumerTargetLockfile(validatedLock, stagedRoot);
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
      await verifyConsumerTargetLockfile(validatedLock, stagedRoot);
      const changed = changedInventoryPaths(
        await repositoryInventory(beforeRoot),
        await repositoryInventory(stagedRoot)
      );
      const allowed = allowedUpgradePaths(options.current, isAuthorityV3(options.authority));
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
      assertCapturedConsumerTargetLockfile(validatedLock, operations);
      return Object.freeze({ operations: Object.freeze(operations) });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  private async projectGenerationFiles(
    options: PrepareGenerationOptions,
    fileInput: UpgradeFileInput
  ): Promise<ConsumerUpgradeFileProjection> {
    const authority = options.authority;
    const current = options.current;
    if (current.schemaVersion === 1 && isAuthorityV1(authority)) {
      return projectConsumerUpgradeFiles({
        ...fileInput,
        authority,
        current
      });
    }
    if (isAuthorityV3(authority) && current.schemaVersion === 3) {
      if (options.selection === undefined) {throw new Error("unreachable");}
      return projectConsumerUpgradeFiles({
        ...fileInput,
        authority,
        current,
        selection: options.selection
      });
    }
    if (isAuthorityV2(authority)) {
      return current.schemaVersion === 1
        ? projectConsumerUpgradeFiles({
            ...fileInput, authority, current
          })
        : projectConsumerUpgradeFiles({
            ...fileInput, authority, current
          });
    }
    throw new Error("unreachable");
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
    readonly targetLockfile?: Uint8Array;
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  }): Promise<PreparedConsumerUpgradeV1> {
    const selectedLock = options.targetLockfile === undefined ? undefined
      : Uint8Array.from(options.targetLockfile);
    return this.prepareGeneration({ ...options, ...(selectedLock === undefined ? {} : { selectedLock }) });
  }

  public prepareV3(options: {
    readonly authority: ConsumerUpgradeAuthorityV3;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
    readonly managedPreimages: ConsumerUpgradeManagedPreimagesV2;
    readonly selection: ManagedSuccessorSelectionV3;
  }): Promise<PreparedConsumerUpgradeV1> {
    return this.prepareGeneration(options);
  }

  private async activateAndVerifyGeneration(options: {
    readonly authority: ConsumerUpgradeAuthority;
    readonly consumerRoot: string;
  }): Promise<void> {
    await installCohort(options.consumerRoot, true, this.#environment);
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

  public activateAndVerifyV3(options: {
    readonly authority: ConsumerUpgradeAuthorityV3;
    readonly consumerRoot: string;
  }): Promise<void> {
    return this.activateAndVerifyGeneration(options);
  }

  private async restoreAndVerifyGeneration(options: {
    readonly consumerRoot: string;
    readonly current: UpgradeDesiredState;
  }): Promise<void> {
    await installCohort(options.consumerRoot, true, this.#environment);
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

  public async restoreAndVerifyV3(options: {
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV3;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  }): Promise<void> {
    await assertCleanGitRoot(options.consumerRoot);
    await assertProvedSourceSnapshot({
      current: options.current,
      expected: options.expectedSourceSnapshot,
      sourceRoot: options.consumerRoot
    });
  }
}

export const nodeConsumerUpgradeSandbox: ConsumerUpgradeSandboxPort =
  Object.freeze(new NodeConsumerUpgradeSandbox());

export { nodeConsumerTargetLockfileReader } from "./node-consumer-target-lockfile.js";
