import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { registryLockfile, runCommand, writeJson } from "./pack-test-support.mjs";
import {
  localModeJson,
  localModeRecord,
  rejectPackedFoundation,
  runPackedFoundation,
  verifyPackedCommandAdmission,
  verifyPackedOrdinaryCommands,
  type PackedLocalModeCommand,
} from "./packed-local-mode-command.ts";
import { verifyPackedLocalModeCustody } from "./packed-local-mode-custody.ts";

interface PackedLocalModeInput {
  readonly archivePath: string;
  readonly archiveFileSpecifier: string;
  readonly documentAuthoringArchiveFileSpecifier: string;
  readonly mutationArchiveFileSpecifier: string;
  readonly packageManager: string;
  readonly packageVersion: string;
  readonly repositoryRoot: string;
  readonly temporaryRoot: string;
  readonly runPnpm: (args: readonly string[], cwd: string) => Promise<unknown>;
}

interface LocalModeInstallation extends PackedLocalModeInput {
  readonly consumerRoot: string;
}

async function createLocalModeConsumer(input: LocalModeInstallation): Promise<string> {
  await mkdir(input.consumerRoot, { recursive: true });
  await writeJson(join(input.consumerRoot, "package.json"), {
    name: "foundation-local-mode-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: input.packageManager,
    devDependencies: {
      "@agent-teams/engineering-foundation": input.packageVersion,
    },
  });
  await writeFile(
    join(input.consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\noverrides:\n  "@agent-teams/document-authoring": ${JSON.stringify(input.documentAuthoringArchiveFileSpecifier)}\n  "@agent-teams/engineering-foundation": ${JSON.stringify(input.archiveFileSpecifier)}\n  "@agent-teams/repository-mutation": ${JSON.stringify(input.mutationArchiveFileSpecifier)}\n`,
    "utf8",
  );
  const siblingRoot = join(input.consumerRoot, "packages", "sibling");
  await mkdir(siblingRoot, { recursive: true });
  await writeJson(join(siblingRoot, "package.json"), {
    name: "foundation-local-mode-sibling",
    version: "0.0.0",
    private: true,
  });
  await input.runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile"], input.consumerRoot);
  await runCommand("git", ["init", "--quiet"], input.consumerRoot);
  return siblingRoot;
}

async function assertRegistryRejected(
  input: PackedLocalModeCommand,
  reason: string,
): Promise<void> {
  const failure = await rejectPackedFoundation(
    input,
    ["assert-registry", "--consumer", input.consumerRoot, "--json"],
    1,
  );
  assert.equal(failure.stderr, "", reason);
  const envelope = localModeJson(failure.stdout);
  assert.equal(localModeRecord(envelope["error"])["code"], "REGISTRY_MODE_REQUIRED", reason);
}

async function configureRegistryEvidence(
  input: LocalModeInstallation & PackedLocalModeCommand,
): Promise<void> {
  const archiveIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(input.archivePath))
    .digest("base64")}`;
  const lockfile = registryLockfile(input.packageVersion, archiveIntegrity);
  await writeFile(
    join(input.consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\n`,
    "utf8",
  );
  await writeFile(join(input.consumerRoot, "pnpm-lock.yaml"), lockfile, "utf8");
  await assertRegistryRejected(
    input,
    "Registry assertion accepted a stale local virtual-store installation.",
  );
  await writeFile(join(input.consumerRoot, "node_modules", ".pnpm", "lock.yaml"), lockfile, "utf8");
  await runPackedFoundation(input, ["assert-dev-only", "--consumer", input.consumerRoot]);
  await runPackedFoundation(input, ["assert-registry", "--consumer", input.consumerRoot]);
}

interface LifecycleState {
  readonly paths: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, string>>;
}

async function captureLifecycleState(
  consumerRoot: string,
  siblingRoot: string,
): Promise<LifecycleState> {
  const paths = {
    manifest: join(consumerRoot, "package.json"),
    lockfile: join(consumerRoot, "pnpm-lock.yaml"),
    workspace: join(consumerRoot, "pnpm-workspace.yaml"),
    siblingSentinel: join(siblingRoot, "node_modules", "foundation-lifecycle-sentinel.txt"),
  };
  await mkdir(join(siblingRoot, "node_modules"), { recursive: true });
  await writeFile(paths.siblingSentinel, "preserve-me\n", "utf8");
  return {
    paths,
    expected: {
      manifest: await readFile(paths.manifest, "utf8"),
      lockfile: await readFile(paths.lockfile, "utf8"),
      workspace: await readFile(paths.workspace, "utf8"),
      siblingSentinel: "preserve-me\n",
    },
  };
}

async function assertLifecycleStateUnchanged(
  state: LifecycleState,
  operation: string,
): Promise<void> {
  for (const [name, path] of Object.entries(state.paths)) {
    if ((await readFile(path, "utf8")) !== state.expected[name]) {
      throw new Error(`Local ${operation} changed ${name}.`);
    }
  }
}

async function assertAttachDetachLifecycle(
  input: LocalModeInstallation & PackedLocalModeCommand,
  state: LifecycleState,
): Promise<void> {
  const { stdout: attachOutput } = await runPackedFoundation(input, [
    "attach",
    input.repositoryRoot,
    "--consumer",
    input.consumerRoot,
    "--json",
  ]);
  if (localModeJson(attachOutput)["mode"] !== "LOCAL") {
    throw new Error(`Local attach failed: ${attachOutput}`);
  }
  await assertLifecycleStateUnchanged(state, "attach");

  const { stdout: detachOutput } = await runPackedFoundation(input, [
    "detach",
    "--consumer",
    input.consumerRoot,
    "--json",
  ]);
  if (localModeJson(detachOutput)["mode"] !== "REGISTRY") {
    throw new Error(`Registry restoration failed: ${detachOutput}`);
  }
  await assertLifecycleStateUnchanged(state, "detach");
}

export async function verifyPackedLocalMode(input: PackedLocalModeInput): Promise<void> {
  const consumerRoot = join(input.temporaryRoot, "local-mode-consumer");
  const installation = Object.freeze({ ...input, consumerRoot });
  const siblingRoot = await createLocalModeConsumer(installation);
  // Bind the archive's physical CLI before attach changes the public package link.
  const foundationCli = await realpath(
    join(consumerRoot, "node_modules", "@agent-teams", "engineering-foundation", "dist", "cli.js"),
  );
  const installedModules = await realpath(join(consumerRoot, "node_modules"));
  const suffix = relative(installedModules, foundationCli);
  assert.ok(suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  const context = Object.freeze({
    ...installation,
    foundationCli,
    installedPackageRoot: dirname(dirname(foundationCli)),
  });
  await assertRegistryRejected(context, "Registry assertion accepted a local tarball override.");
  await configureRegistryEvidence(context);
  const state = await captureLifecycleState(consumerRoot, siblingRoot);
  await verifyPackedOrdinaryCommands(context, input.packageVersion);
  await verifyPackedCommandAdmission(context, input.repositoryRoot);
  await assert.rejects(lstat(join(consumerRoot, ".agent-teams-local")), { code: "ENOENT" });
  await assertLifecycleStateUnchanged(state, "command admission");
  await assertAttachDetachLifecycle(context, state);
  await verifyPackedLocalModeCustody(context);
  await assertLifecycleStateUnchanged(state, "custody and recovery");
}
