import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { FoundationError } from "../errors.js";
import { inspectFoundationMode, isExactVersion } from "./inspection.js";
import type {
  AttachResult,
  FoundationLinkState,
  FoundationStatus,
  ProcessRunner
} from "./types.js";
import {
  FOUNDATION_PACKAGE_NAME,
  LOCAL_STATE_DIRECTORY,
  LOCAL_STATE_FILE
} from "./types.js";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

export interface FoundationLocalModeServiceOptions {
  readonly runner: ProcessRunner;
  readonly now?: () => Date;
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FoundationError("PACKAGE_INVALID", `Invalid package.json at ${path}.`);
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function resolveTargetPackageRoot(targetPath: string): Promise<string> {
  const root = await realpath(resolve(targetPath));
  const directManifest = join(root, "package.json");
  if (await pathExists(directManifest)) {
    const manifest = await readPackageManifest(root);
    if (manifest.name === FOUNDATION_PACKAGE_NAME) {
      return root;
    }
  }

  const workspacePackage = join(root, "packages", "engineering-foundation");
  if (await pathExists(join(workspacePackage, "package.json"))) {
    const manifest = await readPackageManifest(workspacePackage);
    if (manifest.name === FOUNDATION_PACKAGE_NAME) {
      return await realpath(workspacePackage);
    }
  }

  throw new FoundationError(
    "PACKAGE_INVALID",
    `Target does not contain ${FOUNDATION_PACKAGE_NAME}.`
  );
}

async function writeLinkState(
  consumerRoot: string,
  state: FoundationLinkState
): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, destination);
}

export class FoundationLocalModeService {
  readonly #runner: ProcessRunner;
  readonly #now: () => Date;

  constructor(options: FoundationLocalModeServiceOptions) {
    this.#runner = options.runner;
    this.#now = options.now ?? (() => new Date());
  }

  async status(consumerPath: string): Promise<FoundationStatus> {
    const status = await inspectFoundationMode(consumerPath);
    if (status.linkState === undefined) {
      return status;
    }

    try {
      const sourceGitCommit = (
        await this.#runner.run({
          command: "git",
          args: [
            "-C",
            status.linkState.targetPackageRoot,
            "rev-parse",
            "HEAD"
          ],
          cwd: status.consumerRoot
        })
      ).stdout.trim();
      const sourceGitDirty =
        (
          await this.#runner.run({
            command: "git",
            args: [
              "-C",
              status.linkState.targetPackageRoot,
              "status",
              "--porcelain"
            ],
            cwd: status.consumerRoot
          })
        ).stdout.trim().length > 0;
      return { ...status, sourceGitCommit, sourceGitDirty };
    } catch (error) {
      return {
        ...status,
        mode: "INVALID",
        issues: [
          ...status.issues,
          `Local foundation Git evidence is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        ]
      };
    }
  }

  async attach(
    consumerPath: string,
    targetPath: string
  ): Promise<AttachResult> {
    const before = await inspectFoundationMode(consumerPath);
    if (
      before.mode !== "REGISTRY" ||
      before.dependencySpec === undefined ||
      !isExactVersion(before.dependencySpec)
    ) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Consumer must be in valid registry mode with an exact ${FOUNDATION_PACKAGE_NAME} version before attach.`
      );
    }

    const consumerRoot = before.consumerRoot;
    const targetPackageRoot = await resolveTargetPackageRoot(targetPath);
    if (targetPackageRoot === consumerRoot) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        "Foundation target cannot be the consumer repository."
      );
    }

    const targetManifest = await readPackageManifest(targetPackageRoot);
    if (
      targetManifest.name !== FOUNDATION_PACKAGE_NAME ||
      typeof targetManifest.version !== "string"
    ) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        "Foundation target package identity or version is invalid."
      );
    }
    for (const output of ["dist/cli.js", "dist/index.js"]) {
      if (!(await pathExists(join(targetPackageRoot, output)))) {
        throw new FoundationError(
          "PACKAGE_INVALID",
          `Foundation target is not built: missing ${output}.`
        );
      }
    }

    const gitCommit = (
      await this.#runner.run({
        command: "git",
        args: ["-C", targetPackageRoot, "rev-parse", "HEAD"],
        cwd: consumerRoot
      })
    ).stdout.trim();
    const gitDirty =
      (
        await this.#runner.run({
          command: "git",
          args: ["-C", targetPackageRoot, "status", "--porcelain"],
          cwd: consumerRoot
        })
      ).stdout.trim().length > 0;

    const excludeResult = await this.#runner.run({
      command: "git",
      args: ["-C", consumerRoot, "rev-parse", "--git-path", "info/exclude"],
      cwd: consumerRoot
    });
    const excludePathCandidate = excludeResult.stdout.trim();
    const excludePath = isAbsolute(excludePathCandidate)
      ? excludePathCandidate
      : resolve(consumerRoot, excludePathCandidate);
    await mkdir(dirname(excludePath), { recursive: true });
    const exclude = await readFile(excludePath, "utf8").catch(() => "");
    if (!exclude.split(/\r?\n/u).includes(`${LOCAL_STATE_DIRECTORY}/`)) {
      const separator =
        exclude.length === 0 || exclude.endsWith("\n") ? "" : "\n";
      await appendFile(
        excludePath,
        `${separator}${LOCAL_STATE_DIRECTORY}/\n`,
        "utf8"
      );
    }

    await this.#runner.run({
      command: "pnpm",
      args: ["link", targetPackageRoot],
      cwd: consumerRoot
    });

    const installedPackageRoot = await realpath(
      join(consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME)
    );
    if (installedPackageRoot !== targetPackageRoot) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "pnpm link completed but the installed package does not resolve to the target."
      );
    }

    await writeLinkState(consumerRoot, {
      schemaVersion: 1,
      consumerRoot,
      targetPackageRoot,
      packageVersion: targetManifest.version,
      gitCommit,
      gitDirty,
      attachedAt: this.#now().toISOString()
    });

    const status = await this.status(consumerRoot);
    if (status.mode !== "LOCAL") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Local attach verification failed: ${status.issues.join(" ")}`
      );
    }
    return { status, targetPackageRoot };
  }

  async detach(consumerPath: string): Promise<FoundationStatus> {
    const before = await inspectFoundationMode(consumerPath);
    if (
      before.dependencySpec === undefined ||
      !isExactVersion(before.dependencySpec)
    ) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Consumer must retain an exact ${FOUNDATION_PACKAGE_NAME} registry dependency.`
      );
    }

    await this.#runner.run({
      command: "pnpm",
      args: ["unlink", FOUNDATION_PACKAGE_NAME],
      cwd: before.consumerRoot
    });
    await this.#runner.run({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: before.consumerRoot
    });
    await rm(join(before.consumerRoot, LOCAL_STATE_DIRECTORY), {
      force: true,
      recursive: true
    });

    const after = await inspectFoundationMode(before.consumerRoot);
    if (after.mode !== "REGISTRY") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Registry restoration failed: ${after.issues.join(" ")}`
      );
    }
    return after;
  }

  async assertRegistry(consumerPath: string): Promise<FoundationStatus> {
    const status = await inspectFoundationMode(consumerPath);
    if (status.mode !== "REGISTRY") {
      throw new FoundationError(
        "REGISTRY_MODE_REQUIRED",
        `Registry foundation mode required: ${status.issues.join(" ") || status.mode}`
      );
    }
    return status;
  }
}
