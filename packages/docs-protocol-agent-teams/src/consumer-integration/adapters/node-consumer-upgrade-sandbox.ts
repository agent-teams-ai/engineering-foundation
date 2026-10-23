import {
  assertCapturedConsumerTargetLockfile,
  validateConsumerTargetLockfile,
  verifyConsumerTargetLockfile,
} from "./node-consumer-target-lockfile.js";
import { consumerProcessEnvironment } from "./node-consumer-environment.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsumerUpgradeManagedPreimagesV2,
  type ConsumerUpgradeSandboxPort,
  type PreparedConsumerUpgradeV1,
} from "../application/ports/consumer-upgrade.js";
import {
  type ConsumerIntegrationDesiredStateV1,
  type ConsumerIntegrationDesiredStateV3,
  type ConsumerIntegrationSnapshot,
  type ConsumerUpgradeAuthorityV1,
  type ConsumerUpgradeAuthorityV2,
} from "../domain/model.js";
import { projectConsumerUpgradeFiles } from "./consumer-upgrade-file-projectors.js";
import { extractHead } from "./node-consumer-upgrade-archive.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  INTEGRATION_PROFILE_PATH,
  MAXIMUM_MANIFEST_BYTES,
  MAXIMUM_PROFILE_BYTES,
  MAXIMUM_WORKSPACE_BYTES,
  readStableConsumerFile,
} from "./node-consumer-repository-files.js";
import {
  applyTargetIntegration,
  assertInstalledHistoricalIntegrationCurrent,
  assertInstalledIntegrationCurrent,
} from "./node-consumer-upgrade-target.js";
import {
  allowedUpgradePaths,
  assertManagedAssetsCreatedV2,
  assertProvedSourceSnapshot,
  resetProvedManagedAssetsV2,
} from "./node-consumer-upgrade-source-proof.js";
import {
  type ConsumerUpgradeAuthority,
  type UpgradeDesiredState,
  isAuthorityV1,
  WORKSPACE_PATH,
  execute,
  assertCleanGitRoot,
  contained,
  writeProjectedFile,
  repositoryInventory,
  changedInventoryPaths,
  operationForChangedPath,
  installCohort,
} from "./consumer-upgrade-sandbox-support.js";
async function readUpgradeFiles(stagedRoot: string) {
  const [profile, manifest] = await Promise.all([
    readStableConsumerFile(stagedRoot, INTEGRATION_PROFILE_PATH, MAXIMUM_PROFILE_BYTES, true),
    readStableConsumerFile(stagedRoot, "package.json", MAXIMUM_MANIFEST_BYTES, true),
  ]);
  if (profile.state !== "file" || manifest.state !== "file") {
    throw new Error("unreachable");
  }
  const workspace = await readStableConsumerFile(
    stagedRoot,
    WORKSPACE_PATH,
    MAXIMUM_WORKSPACE_BYTES,
    false,
  );
  const fileInput = {
    profile: profile.bytes,
    manifest: manifest.bytes,
    ...(workspace.state === "file" ? { workspace: workspace.bytes } : {}),
  };
  return fileInput;
}

export class NodeConsumerUpgradeSandbox implements ConsumerUpgradeSandboxPort {
  readonly #environment: () => NodeJS.ProcessEnv;

  public constructor(environment: () => NodeJS.ProcessEnv = consumerProcessEnvironment) {
    this.#environment = environment;
  }

  private async prepareGeneration(options: {
    readonly selectedLock?: Uint8Array;
    readonly authority: ConsumerUpgradeAuthority;
    readonly consumerRoot: string;
    readonly current: UpgradeDesiredState;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
    readonly managedPreimages?: ConsumerUpgradeManagedPreimagesV2;
  }): Promise<PreparedConsumerUpgradeV1> {
    const { selectedLock } = options;
    const head = await assertCleanGitRoot(options.consumerRoot);
    if (head !== options.expectedSourceRevision) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
        "Consumer Git HEAD changed after the source Cohort was proved current.",
      );
    }
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "docs-consumer-upgrade-")));
    const beforeRoot = join(temporary, "before");
    const stagedRoot = join(temporary, "staged");
    try {
      await Promise.all([
        extractHead({ root: options.consumerRoot, head, target: beforeRoot }, execute),
        extractHead({ root: options.consumerRoot, head, target: stagedRoot }, execute),
      ]);
      await assertProvedSourceSnapshot({
        current: options.current,
        expected: options.expectedSourceSnapshot,
        sourceRoot: beforeRoot,
      });
      await execute("git", ["init", "-q"], stagedRoot);
      const fileInput = await readUpgradeFiles(stagedRoot);
      let projected;
      if (options.current.schemaVersion === 1 && isAuthorityV1(options.authority)) {
        projected = await projectConsumerUpgradeFiles({
          ...fileInput,
          authority: options.authority,
          current: options.current,
        });
      } else if (!isAuthorityV1(options.authority)) {
        projected =
          options.current.schemaVersion === 1
            ? await projectConsumerUpgradeFiles({
                ...fileInput,
                authority: options.authority,
                current: options.current,
              })
            : await projectConsumerUpgradeFiles({
                ...fileInput,
                authority: options.authority,
                current: options.current,
              });
      } else {
        throw new Error("unreachable");
      }
      const validatedLock = await validateConsumerTargetLockfile(
        selectedLock,
        projected.profile,
        options.current,
        beforeRoot,
      );
      await Promise.all([
        writeProjectedFile(stagedRoot, INTEGRATION_PROFILE_PATH, projected.profile),
        writeProjectedFile(stagedRoot, "package.json", projected.manifest),
        ...(projected.migrationWorkspace === undefined
          ? []
          : [writeProjectedFile(stagedRoot, WORKSPACE_PATH, projected.migrationWorkspace)]),
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
        if (options.managedPreimages === undefined) {
          throw new Error("unreachable");
        }
        await resetProvedManagedAssetsV2({
          current: options.current,
          managedPreimages: options.managedPreimages,
          stagedRoot,
        });
      } else if (!isAuthorityV1(options.authority)) {
        await Promise.all(
          [
            options.current.callerWorkflowPath,
            options.current.managedStatePath,
            options.current.skillPath,
          ].map((path) => rm(contained(stagedRoot, path))),
        );
      }
      await applyTargetIntegration(stagedRoot, options.authority.cohort.cohortId, execute);
      if (!isAuthorityV1(options.authority)) {
        await assertManagedAssetsCreatedV2(stagedRoot, options.current);
      }
      await verifyConsumerTargetLockfile(validatedLock, stagedRoot);
      const changed = changedInventoryPaths(
        await repositoryInventory(beforeRoot),
        await repositoryInventory(stagedRoot),
      );
      const allowed = allowedUpgradePaths(options.current);
      const unexpected = changed.filter((path) => !allowed.has(path));
      if (unexpected.length > 0) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_SCOPE_VIOLATION",
          `Disposable upgrade changed paths outside its closed inventory: ${unexpected.slice(0, 8).join(", ")}.`,
        );
      }
      if (
        changed.includes(WORKSPACE_PATH) &&
        (
          await readStableConsumerFile(
            options.consumerRoot,
            WORKSPACE_PATH,
            MAXIMUM_WORKSPACE_BYTES,
            false,
          )
        ).state === "absent"
      ) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_SCOPE_VIOLATION",
          "Cohort upgrade cannot introduce a previously absent pnpm workspace authority.",
        );
      }
      if ((await assertCleanGitRoot(options.consumerRoot)) !== head) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
          "Consumer Git HEAD changed while the successor was staged.",
        );
      }
      const operations = await Promise.all(
        changed.map((path) =>
          operationForChangedPath({
            path,
            sourceRoot: beforeRoot,
            stagedRoot,
          }),
        ),
      );
      assertCapturedConsumerTargetLockfile(validatedLock, operations);
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
    readonly targetLockfile?: Uint8Array;
    readonly authority: ConsumerUpgradeAuthorityV2;
    readonly consumerRoot: string;
    readonly current: ConsumerIntegrationDesiredStateV1;
    readonly expectedSourceRevision: string;
    readonly expectedSourceSnapshot: ConsumerIntegrationSnapshot;
  }): Promise<PreparedConsumerUpgradeV1> {
    const selectedLock =
      options.targetLockfile === undefined ? undefined : Uint8Array.from(options.targetLockfile);
    return this.prepareGeneration({
      ...options,
      ...(selectedLock === undefined ? {} : { selectedLock }),
    });
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
}

export const nodeConsumerUpgradeSandbox: ConsumerUpgradeSandboxPort = Object.freeze(
  new NodeConsumerUpgradeSandbox(),
);

export { nodeConsumerTargetLockfileReader } from "./node-consumer-target-lockfile.js";
