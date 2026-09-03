import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  captureFailure,
  registryLockfile,
  runCommand,
  writeJson
} from "./pack-test-support.mjs";

async function runFoundation(input, args) {
  return runCommand(
    process.execPath,
    [input.foundationCli, ...args],
    input.consumerRoot
  );
}

async function createLocalModeConsumer(input) {
  await mkdir(input.consumerRoot, { recursive: true });
  await writeJson(join(input.consumerRoot, "package.json"), {
    name: "foundation-local-mode-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: input.packageManager,
    devDependencies: {
      "@agent-teams/engineering-foundation": input.packageVersion
    }
  });
  await writeFile(
    join(input.consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\noverrides:\n  "@agent-teams/document-authoring": ${JSON.stringify(input.documentAuthoringArchiveFileSpecifier)}\n  "@agent-teams/engineering-foundation": ${JSON.stringify(input.archiveFileSpecifier)}\n  "@agent-teams/repository-mutation": ${JSON.stringify(input.mutationArchiveFileSpecifier)}\n`,
    "utf8"
  );
  const siblingRoot = join(input.consumerRoot, "packages", "sibling");
  await mkdir(siblingRoot, { recursive: true });
  await writeJson(join(siblingRoot, "package.json"), {
    name: "foundation-local-mode-sibling",
    version: "0.0.0",
    private: true
  });
  await input.runPnpm(
    ["install", "--ignore-scripts", "--no-frozen-lockfile"],
    input.consumerRoot
  );
  await runCommand("git", ["init", "--quiet"], input.consumerRoot);
  return siblingRoot;
}

async function assertRegistryRejected(input, reason) {
  const failure = await captureFailure(() =>
    runFoundation(input, ["assert-registry", "--consumer", input.consumerRoot])
  );
  if (failure === undefined) {
    throw new Error(reason);
  }
}

async function configureRegistryEvidence(input) {
  const archiveIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(input.archivePath))
    .digest("base64")}`;
  const lockfile = registryLockfile(input.packageVersion, archiveIntegrity);
  await writeFile(
    join(input.consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\n`,
    "utf8"
  );
  await writeFile(join(input.consumerRoot, "pnpm-lock.yaml"), lockfile, "utf8");
  await assertRegistryRejected(
    input,
    "Registry assertion accepted a stale local virtual-store installation."
  );
  await writeFile(
    join(input.consumerRoot, "node_modules", ".pnpm", "lock.yaml"),
    lockfile,
    "utf8"
  );
  await runFoundation(input, ["assert-dev-only", "--consumer", input.consumerRoot]);
  await runFoundation(input, ["assert-registry", "--consumer", input.consumerRoot]);
}

async function captureLifecycleState(consumerRoot, siblingRoot) {
  const paths = {
    manifest: join(consumerRoot, "package.json"),
    lockfile: join(consumerRoot, "pnpm-lock.yaml"),
    workspace: join(consumerRoot, "pnpm-workspace.yaml"),
    siblingSentinel: join(siblingRoot, "node_modules", "foundation-lifecycle-sentinel.txt")
  };
  await mkdir(join(siblingRoot, "node_modules"), { recursive: true });
  await writeFile(paths.siblingSentinel, "preserve-me\n", "utf8");
  return {
    paths,
    expected: {
      manifest: await readFile(paths.manifest, "utf8"),
      lockfile: await readFile(paths.lockfile, "utf8"),
      workspace: await readFile(paths.workspace, "utf8"),
      siblingSentinel: "preserve-me\n"
    }
  };
}

async function assertLifecycleStateUnchanged(state, operation) {
  for (const [name, path] of Object.entries(state.paths)) {
    if ((await readFile(path, "utf8")) !== state.expected[name]) {
      throw new Error(`Local ${operation} changed ${name}.`);
    }
  }
}

async function assertAttachDetachLifecycle(input, siblingRoot) {
  const state = await captureLifecycleState(input.consumerRoot, siblingRoot);
  const { stdout: attachOutput } = await runFoundation(input, [
    "attach",
    input.repositoryRoot,
    "--consumer",
    input.consumerRoot,
    "--json"
  ]);
  if (JSON.parse(attachOutput).mode !== "LOCAL") {
    throw new Error(`Local attach failed: ${attachOutput}`);
  }
  await assertLifecycleStateUnchanged(state, "attach");

  const { stdout: detachOutput } = await runFoundation(input, [
    "detach",
    "--consumer",
    input.consumerRoot,
    "--json"
  ]);
  if (JSON.parse(detachOutput).mode !== "REGISTRY") {
    throw new Error(`Registry restoration failed: ${detachOutput}`);
  }
  await assertLifecycleStateUnchanged(state, "detach");
}

export async function verifyPackedLocalMode(input) {
  const consumerRoot = join(input.temporaryRoot, "local-mode-consumer");
  const installation = Object.freeze({ ...input, consumerRoot });
  const siblingRoot = await createLocalModeConsumer(installation);
  const context = Object.freeze({
    ...installation,
    foundationCli: join(
      consumerRoot,
      "node_modules",
      "@agent-teams",
      "engineering-foundation",
      "dist",
      "cli.js"
    )
  });
  await assertRegistryRejected(context, "Registry assertion accepted a local tarball override.");
  await configureRegistryEvidence(context);
  await assertAttachDetachLifecycle(context, siblingRoot);
}
