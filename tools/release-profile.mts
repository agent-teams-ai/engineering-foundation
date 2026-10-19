import { spawn } from "node:child_process";
import { copyFile, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExplicitSourceGitAuthority, assertPnpmProfileQualificationRoot, prepareProfileProjection } from "./dev.mts";
import { resolveQualificationExecutables } from "./executable-policy.mts";
import { assertBunRootProjection, readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";

interface ReleaseCommand {
  readonly sourceRoot: string;
  readonly sourceSha: string;
  readonly node: string;
  readonly bun: string;
}

export interface VersionLockEvidence {
  readonly bunLockSha256: string;
  readonly pnpmLockSha256: string;
  readonly pnpmLockChanged: boolean;
}

function digest(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<number> {
  return new Promise((_resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: environment, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Release command terminated by ${signal}.`));
        return;
      }
      _resolve(code ?? 1);
    });
  });
}

async function requireFile(path: string, message: string): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (metadata?.isFile() !== true) {
    throw new Error(message);
  }
}

async function releaseCommand(): Promise<ReleaseCommand> {
  const sourceRoot = repositoryRoot;
  const authority = await assertExplicitSourceGitAuthority(sourceRoot);
  const runtime = await resolveQualificationExecutables("bun");
  const bun = runtime.bun;
  if (bun === undefined) {
    throw new Error("Release versioning requires admitted Bun 1.4.3.");
  }
  await assertBunRootProjection(sourceRoot);
  await requireFile(resolve(sourceRoot, "bun.lock"), "Release versioning requires the authoritative Bun lock.");
  await requireFile(resolve(sourceRoot, "pnpm-lock.yaml"), "Release versioning requires the authoritative pnpm lock.");
  await requireFile(resolve(sourceRoot, "node_modules/@changesets/cli/bin.js"), "Release versioning requires a Bun-installed Changesets CLI.");
  const installed = await readFile(resolve(sourceRoot, "node_modules/.pnpm/lock.yaml"), "utf8").catch(() => null);
  if (installed !== null) {
    throw new Error("The tracked source worktree must not contain a pnpm installation.");
  }
  return {
    sourceRoot,
    sourceSha: authority.sourceCommit,
    node: runtime.node,
    bun
  };
}

async function assertManagerCustody(sourceRoot: string, expected: string): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(sourceRoot, "package.json"), "utf8")) as Record<string, unknown>;
  if (manifest["packageManager"] !== expected) {
    throw new Error("Release operation changed or projected the tracked root packageManager.");
  }
  const authority = await assertExplicitSourceGitAuthority(sourceRoot);
  if (authority.sourceRoot !== await realpath(sourceRoot)) {
    throw new Error("Release operation changed source Git authority.");
  }
}

export async function refreshVersionLocks(command: ReleaseCommand): Promise<VersionLockEvidence> {
  const policy = await readRepositoryRuntimePolicy(command.sourceRoot);
  const expectedManager = `bun@${policy.toolchain.bun.version}`;
  const pnpmBefore = await readFile(resolve(command.sourceRoot, "pnpm-lock.yaml"));
  const bunStatus = await run(
    command.bun,
    ["install", "--lockfile-only", "--ignore-scripts", "--linker=isolated"],
    command.sourceRoot,
    process.env
  );
  if (bunStatus !== 0) {
    throw new Error("Bun lock refresh failed.");
  }
  const targetRoot = resolve(command.sourceRoot, `.worker-tmp/profiles/release-node-${command.sourceSha}`);
  await prepareProfileProjection({
    profile: "node",
    sourceRoot: command.sourceRoot,
    targetRoot,
    sourceSha: command.sourceSha
  });
  const pnpmStatus = await run(
    command.node,
    [resolve(repositoryRoot, "tools/pnpm-command.mts"), "install", "--lockfile-only", "--ignore-scripts", "--engine-strict"],
    targetRoot,
    process.env
  );
  if (pnpmStatus !== 0) {
    throw new Error("pnpm lock refresh failed in the isolated Node profile.");
  }
  await assertPnpmProfileQualificationRoot(targetRoot, command.sourceRoot, false);
  const projectedPnpm = await readFile(resolve(targetRoot, "pnpm-lock.yaml"));
  const pnpmLockChanged = !pnpmBefore.equals(projectedPnpm);
  if (pnpmLockChanged) {
    await copyFile(resolve(targetRoot, "pnpm-lock.yaml"), resolve(command.sourceRoot, "pnpm-lock.yaml"));
  }
  await assertManagerCustody(command.sourceRoot, expectedManager);
  const bunLock = await readFile(resolve(command.sourceRoot, "bun.lock"));
  const pnpmLock = await readFile(resolve(command.sourceRoot, "pnpm-lock.yaml"));
  return {
    bunLockSha256: digest(bunLock),
    pnpmLockSha256: digest(pnpmLock),
    pnpmLockChanged
  };
}

async function version(): Promise<number> {
  const command = await releaseCommand();
  const policy = await readRepositoryRuntimePolicy(command.sourceRoot);
  const expectedManager = `bun@${policy.toolchain.bun.version}`;
  const authority = await assertExplicitSourceGitAuthority(command.sourceRoot);
  const status = await run(command.bun, ["run", "release:version"], command.sourceRoot, {
    ...process.env,
    ...authority.environment,
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: command.node,
    AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: command.bun,
    PATH: `${dirname(command.node)}${delimiter}${process.env["PATH"] ?? ""}`
  });
  if (status !== 0) {
    return status;
  }
  const evidence = await refreshVersionLocks(command);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  await assertManagerCustody(command.sourceRoot, expectedManager);
  return 0;
}

async function publish(): Promise<number> {
  const command = await releaseCommand();
  const authority = await assertExplicitSourceGitAuthority(command.sourceRoot);
  const targetRoot = resolve(command.sourceRoot, `.worker-tmp/profiles/release-node-${command.sourceSha}`);
  const installStatus = await run(
    command.node,
    [resolve(command.sourceRoot, "tools/dev.mts"), "--profile", "node", "install"],
    command.sourceRoot,
    {
      ...process.env,
      ...authority.environment,
      AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: targetRoot,
      AGENT_TEAMS_FOUNDATION_SOURCE_SHA: command.sourceSha,
      AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: command.sourceRoot,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: command.node
    }
  );
  if (installStatus !== 0) {
    return installStatus;
  }
  const buildStatus = await run(
    command.node,
    [resolve(command.sourceRoot, "tools/dev.mts"), "--profile", "node", "build"],
    command.sourceRoot,
    {
      ...process.env,
      ...authority.environment,
      AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: targetRoot,
      AGENT_TEAMS_FOUNDATION_SOURCE_SHA: command.sourceSha,
      AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: command.sourceRoot,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: command.node
    }
  );
  if (buildStatus !== 0) {
    return buildStatus;
  }
  return run(
    command.node,
    [resolve(targetRoot, "tools/repository-command.mts"), "script", "release:publish"],
    targetRoot,
    {
      ...process.env,
      ...authority.environment,
      AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: targetRoot,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node",
      AGENT_TEAMS_FOUNDATION_SOURCE_SHA: command.sourceSha,
      AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: command.sourceRoot,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: command.node
    }
  );
}

async function main(): Promise<number> {
  const [operation] = process.argv.slice(2);
  if (process.argv.length !== 3 || (operation !== "version" && operation !== "publish")) {
    throw new Error("Usage: release-profile.mts (version|publish)");
  }
  return operation === "version" ? version() : publish();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
