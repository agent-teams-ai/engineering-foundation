import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { type KnownFileTransactionOperationInput } from "@agent-teams/repository-mutation";
import {
  type ConsumerIntegrationDesiredStateV1,
  type ConsumerIntegrationDesiredStateV3,
  type ConsumerUpgradeAuthorityV1,
  type ConsumerUpgradeAuthorityV2,
  type ConsumerUpgradeAuthorityV3,
  type ManagedSuccessorProfile,
} from "../domain/model.js";
import {
  MAXIMUM_INVENTORY_BYTES,
  MAXIMUM_INVENTORY_FILE_BYTES,
  MAXIMUM_INVENTORY_FILES,
} from "./node-consumer-upgrade-archive.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  INTEGRATION_PROFILE_PATH,
  MAXIMUM_LOCKFILE_BYTES,
  MAXIMUM_MANAGED_ASSET_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  MAXIMUM_PROFILE_BYTES,
  MAXIMUM_WORKSPACE_BYTES,
  readStableConsumerFile,
} from "./node-consumer-repository-files.js";
import { assertCleanConsumerGitSource } from "./node-consumer-upgrade-source-proof.js";
export type ConsumerUpgradeAuthority =
  | ConsumerUpgradeAuthorityV1
  | ConsumerUpgradeAuthorityV2
  | ConsumerUpgradeAuthorityV3;
export type UpgradeDesiredState =
  | ConsumerIntegrationDesiredStateV1
  | ConsumerIntegrationDesiredStateV3
  | ManagedSuccessorProfile;

export function isAuthorityV1(
  value: ConsumerUpgradeAuthority,
): value is ConsumerUpgradeAuthorityV1 {
  return value.cohort.schemaVersion === 1;
}

export const WORKSPACE_PATH = "pnpm-workspace.yaml";
const MAXIMUM_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
export interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}
export interface InventoryEntry {
  readonly digest: string;
  readonly kind: "file" | "symlink";
}
export function execute(
  executable: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
  environment?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        ...(environment === undefined ? {} : { env: environment }),
        encoding: "utf8",
        maxBuffer: MAXIMUM_PROCESS_OUTPUT_BYTES,
        signal: AbortSignal.timeout(10 * 60 * 1000),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : undefined;
        if (code !== undefined && allowedExitCodes.includes(code)) {
          resolve({ code, stdout, stderr });
          return;
        }
        // pnpm writes ERR_PNPM_* to stdout and configuration warnings to stderr: keep the tail of both, labelled.
        const streams: readonly (readonly [string, string])[] = [
          ["stderr", stderr],
          ["stdout", stdout],
        ];
        const detail = streams
          .map(([label, text]) => ({ label, tail: text.trim().slice(-2000) }))
          .filter(({ tail }) => tail !== "")
          .map(({ label, tail }) => `${label}: ${tail}`)
          .join("\n");
        reject(
          new ConsumerIntegrationNodeError(
            "DOCS_CONSUMER_UPGRADE_PROCESS_FAILED",
            `${executable} ${args[0] ?? ""} failed${detail === "" ? "." : `: ${detail}`}`,
            { cause: error ?? undefined },
          ),
        );
      },
    );
  });
}

export const assertCleanGitRoot = (root: string): Promise<string> =>
  assertCleanConsumerGitSource(root, execute);

export function contained(root: string, repositoryPath: string): string {
  const path = resolvePath(root, repositoryPath);
  const relation = relative(root, path);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PATH_ESCAPE",
      `Upgrade path escapes the disposable repository: ${repositoryPath}.`,
    );
  }
  return path;
}

export async function writeProjectedFile(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = contained(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function runPnpm(
  root: string,
  args: readonly string[],
  environment: () => NodeJS.ProcessEnv,
  run: typeof execute,
): Promise<void> {
  await run(
    "corepack",
    ["pnpm", ...args],
    root,
    [0],
    args.includes("--offline") ? { ...environment(), COREPACK_ENABLE_NETWORK: "0" } : undefined,
  );
}

function ignoredInventoryPath(prefix: string, name: string): boolean {
  return (
    name === "node_modules" || (prefix === "" && (name === ".git" || name === ".agent-teams-local"))
  );
}

export async function repositoryInventory(root: string): Promise<Map<string, InventoryEntry>> {
  const output = new Map<string, InventoryEntry>();
  let totalBytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (ignoredInventoryPath(prefix, entry.name)) {
        continue;
      }
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      if (output.size >= MAXIMUM_INVENTORY_FILES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded file count.",
        );
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        output.set(path, {
          kind: "symlink",
          digest: createHash("sha256").update(target).digest("hex"),
        });
        continue;
      }
      if (!entry.isFile()) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_INPUT_INVALID",
          `Disposable consumer contains unsupported filesystem evidence: ${path}.`,
        );
      }
      const observation = await readStableConsumerFile(
        root,
        path,
        MAXIMUM_INVENTORY_FILE_BYTES,
        true,
      );
      if (observation.state !== "file") {
        throw new Error("unreachable");
      }
      totalBytes += observation.bytes.byteLength;
      if (totalBytes > MAXIMUM_INVENTORY_BYTES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded byte count.",
        );
      }
      output.set(path, {
        kind: "file",
        digest: createHash("sha256").update(observation.bytes).digest("hex"),
      });
    }
  }
  await visit(root, "");
  return output;
}

export function changedInventoryPaths(
  before: ReadonlyMap<string, InventoryEntry>,
  after: ReadonlyMap<string, InventoryEntry>,
): readonly string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => {
      const left = before.get(path);
      const right = after.get(path);
      return left?.kind !== right?.kind || left?.digest !== right?.digest;
    })
    .toSorted();
}

function maximumBytes(path: string): number {
  if (path === INTEGRATION_PROFILE_PATH) {
    return MAXIMUM_PROFILE_BYTES;
  }
  if (path === "package.json") {
    return MAXIMUM_MANIFEST_BYTES;
  }
  if (path === "pnpm-lock.yaml") {
    return MAXIMUM_LOCKFILE_BYTES;
  }
  if (path === WORKSPACE_PATH) {
    return MAXIMUM_WORKSPACE_BYTES;
  }
  return MAXIMUM_MANAGED_ASSET_BYTES;
}

export async function operationForChangedPath(input: {
  readonly sourceRoot: string;
  readonly path: string;
  readonly stagedRoot: string;
}): Promise<KnownFileTransactionOperationInput> {
  const [preimage, postimage] = await Promise.all([
    readStableConsumerFile(input.sourceRoot, input.path, maximumBytes(input.path), true),
    readStableConsumerFile(input.stagedRoot, input.path, maximumBytes(input.path), true),
  ]);
  if (preimage.state !== "file" || postimage.state !== "file") {
    throw new Error("unreachable");
  }
  return Object.freeze({
    path: input.path,
    precondition: {
      state: "known-file" as const,
      acceptedPreimages: [{ bytes: preimage.bytes, mode: preimage.mode }],
    },
    postimage: { bytes: postimage.bytes, mode: preimage.mode },
  });
}

export async function installCohort(
  root: string,
  offline: boolean,
  environment: () => NodeJS.ProcessEnv,
  frozen = offline,
  run: typeof execute = execute,
): Promise<void> {
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
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  try {
    await runPnpm(
      root,
      [
        "install",
        offline ? "--offline" : "--prefer-offline",
        frozen ? "--frozen-lockfile" : "--no-frozen-lockfile",
        "--package-import-method=copy",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--verify-store-integrity",
      ],
      environment,
      run,
    );
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
        {
          cause: new AggregateError(
            [error, restoreError],
            "Installation and modules restoration failed.",
          ),
        },
      );
    }
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}
