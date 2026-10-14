import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunRootProjection, readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";
import { resolveQualificationExecutables } from "./executable-policy.mts";
import { assertOwnedProfileRoot } from "./profile-root.mts";

type Profile = "bun" | "node";

function parseArguments(arguments_: readonly string[]): { readonly profile: Profile; readonly command: string } {
  let profile: Profile = "bun";
  const rest = [...arguments_];
  while (rest[0] === "--profile") {
    const selected = rest[1];
    if (selected !== "bun" && selected !== "node") {
      throw new Error("--profile must be bun or node.");
    }
    profile = selected;
    rest.splice(0, 2);
  }
  if (rest.length !== 1 || !["install", "build", "check:changed", "check:fast", "security:workflows", "test:qgr:lifecycle:built"].includes(rest[0] ?? "")) {
    throw new Error("Usage: dev.mts [--profile bun|node] (install|build|check:changed|check:fast|security:workflows|test:qgr:lifecycle:built)");
  }
  return { profile, command: rest[0] ?? "" };
}

function run(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((_resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: environment, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Command terminated by ${signal}.`));
        return;
      }
      _resolve(code ?? 1);
    });
  });
}

async function executable(profile: Profile): Promise<{ readonly node: string; readonly bun?: string; readonly manager: string }> {
  const policy = await readRepositoryRuntimePolicy();
  const runtime = await resolveQualificationExecutables(profile);
  const node = runtime.node;
  const bun = runtime.bun;
  const manager = profile === "bun"
    ? bun ?? (() => { throw new Error("Bun executable is unavailable."); })()
    : resolve(repositoryRoot, "tools/pnpm-command.mts");
  if (policy.defaultProfile !== "bun") {
    throw new Error("Runtime policy default profile drifted.");
  }
  return { node, ...(profile === "bun" ? { bun } : {}), manager };
}

const excludedSourceDirectories = new Set([
  ".git",
  ".worker-tmp",
  ".cache",
  "node_modules",
  ".pnpm-store",
  "coverage",
  ".coverage-evidence"
]);

function isExcludedSourceEntry(
  sourceRoot: string,
  path: string,
  entry: {
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  }
): boolean {
  if (excludedSourceDirectories.has(entry.name)) {
    return true;
  }
  if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
    return true;
  }
  const pathParts = relative(sourceRoot, path).split(/[\\/]/u);
  return entry.isDirectory() &&
    pathParts.length === 3 &&
    pathParts[0] === "packages" &&
    pathParts[2] === "dist";
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = (await readdir(source, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const from = resolve(source, entry.name);
    if (isExcludedSourceEntry(source, from, entry)) {
      continue;
    }
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

async function freshProfileRoot(profile: Profile): Promise<string> {
  const requested = process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"];
  if (profile === "bun" && requested === undefined) {
    const installed = resolve(repositoryRoot, "node_modules");
    const entries: string[] = await readdir(installed).catch((): string[] => []);
    if (entries.includes(".pnpm")) {
      throw new Error("The repository has a pnpm installation; use a profile-owned TEST root.");
    }
    return repositoryRoot;
  }
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const sourceDigest = await sourceTreeDigest();
  const profiles = resolve(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(profiles, { recursive: true });
  const target = await assertOwnedProfileRoot(
    requested ?? resolve(repositoryRoot, `.worker-tmp/profiles/${profile}-${sourceSha}`)
  );
  if (profile === "bun") {
    const evidence = await readFile(resolve(target, ".agent-teams-runtime-profile.json"), "utf8")
      .then((source) => JSON.parse(source) as {
        readonly profile?: string;
        readonly sourceSha?: string;
        readonly sourceDigest?: string;
      })
      .catch(() => null);
    const entries = await readdir(resolve(target, "node_modules")).catch((): string[] => []);
    if (
      evidence?.profile === "bun" &&
      evidence.sourceSha === sourceSha &&
      evidence.sourceDigest === sourceDigest &&
      !entries.includes(".pnpm")
    ) {
      return target;
    }
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copyTree(repositoryRoot, target);
  return target;
}

function executionRoot(profile: Profile, sourceSha: string): string {
  return process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"] ??
    (profile === "node" ? resolve(repositoryRoot, `.worker-tmp/profiles/node-${sourceSha}`) : repositoryRoot);
}

async function install(profile: Profile): Promise<number> {
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("Source identity must be a full lowercase Git SHA.");
  }
  const profileRoot = await freshProfileRoot(profile);
  await assertBunRootProjection(profileRoot);
  const policy = await readRepositoryRuntimePolicy(profileRoot);
  const originalManifest = await readFile(resolve(profileRoot, "package.json"), "utf8");
  const originalDigest = createHash("sha256").update(originalManifest).digest("hex");
  if (profile === "node") {
    const derivedManifest = projectPackageManager(
      originalManifest,
      `pnpm@${policy.toolchain.pnpm.version}`
    );
    await writeFile(resolve(profileRoot, "package.json"), derivedManifest, "utf8");
    const derivedDigest = createHash("sha256").update(derivedManifest).digest("hex");
  await writeProfileEvidence(profileRoot, {
    profile,
    sourceSha,
    sourceDigest: await sourceTreeDigest(),
    originalManifestSha256: originalDigest,
    derivedManifestSha256: derivedDigest
  });
  } else {
    await writeProfileEvidence(profileRoot, {
      profile,
      sourceSha,
      sourceDigest: await sourceTreeDigest(),
      originalManifestSha256: originalDigest,
      derivedManifestSha256: originalDigest
    });
  }
  const tools = await executable(profile);
  const managerArgs = profile === "bun"
    ? ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]
    : ["install", "--frozen-lockfile", "--ignore-scripts", "--engine-strict"];
  const command = profile === "bun" ? tools.bun ?? (() => { throw new Error("Bun executable is unavailable."); })() : tools.node;
  const entryArgs = profile === "bun" ? managerArgs : [tools.manager, ...managerArgs];
  const status = await run(command, entryArgs, profileRoot);
  if (status !== 0) {
    return status;
  }
  if (profile === "bun") {
    const initialization = [
      [resolve(profileRoot, "node_modules/@ast-grep/cli/postinstall.js")],
      [resolve(profileRoot, "node_modules/nx/dist/bin/post-install.js")]
    ];
    for (const args of initialization) {
      const initStatus = await run(tools.node, args, profileRoot);
      if (initStatus !== 0) { return initStatus; }
    }
    const selectedRuntime = tools.bun ?? tools.node;
    const qualified = await run(selectedRuntime, [resolve(profileRoot, "tools/qualify-native-tools.mts")], profileRoot);
    return qualified === 0
      ? run(selectedRuntime, [resolve(profileRoot, "tools/dependencies-installed-check.mts")], profileRoot, {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_INSTALLED_INVENTORY: resolve(profileRoot, ".worker-tmp/installed-dependencies.json")
        })
      : qualified;
  }
  return run(tools.node, [tools.manager, "peers", "check", "--lockfile-only"], profileRoot);
}

function projectPackageManager(manifestSource: string, packageManager: string): string {
  const before = JSON.parse(manifestSource) as Record<string, unknown>;
  const projected = manifestSource.replace(
    /("packageManager"\s*:\s*")[^"]+(")/u,
    `$1${packageManager}$2`
  );
  if (projected === manifestSource) {
    throw new Error("The root packageManager field is missing or duplicated.");
  }
  const after = JSON.parse(projected) as Record<string, unknown>;
  const beforeWithoutManager = { ...before };
  const afterWithoutManager = { ...after };
  delete beforeWithoutManager["packageManager"];
  delete afterWithoutManager["packageManager"];
  if (
    JSON.stringify(beforeWithoutManager) !== JSON.stringify(afterWithoutManager) ||
    after["packageManager"] !== packageManager
  ) {
    throw new Error("The Node profile projection may change only packageManager.");
  }
  return projected;
}

async function writeProfileEvidence(
  root: string,
  evidence: {
    readonly profile: Profile;
    readonly sourceSha: string;
    readonly sourceDigest: string;
    readonly originalManifestSha256: string;
    readonly derivedManifestSha256: string;
  }
): Promise<void> {
  await writeFile(resolve(root, ".agent-teams-runtime-profile.json"), `${JSON.stringify({
    ...evidence
  }, null, 2)}\n`, "utf8");
}

export async function sourceTreeDigest(sourceRoot: string = repositoryRoot): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (isExcludedSourceEntry(sourceRoot, path, entry)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(sourceRoot, path));
      }
    }
  };
  await walk(sourceRoot);
  files.sort();
  for (const path of files) {
    hash.update(`${path}\0`);
    hash.update(await readFile(resolve(sourceRoot, path)));
  }
  return hash.digest("hex");
}

async function build(profile: Profile): Promise<number> {
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const root = executionRoot(profile, sourceSha);
  const tools = await executable(profile);
  return run(tools.node, [resolve(root, "node_modules/typescript/bin/tsc"), "--build", "tsconfig.json", "--pretty", "false"], root);
}

async function execute(profile: Profile, command: string): Promise<number> {
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const root = executionRoot(profile, sourceSha);
  const tools = await executable(profile);
  const environment = {
    ...process.env,
    AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: profile,
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: tools.node,
    ...(tools.bun === undefined ? {} : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: tools.bun })
  };
  const launcher = resolve(root, "tools/repository-command.mts");
  const status = await run(tools.node, [launcher, "tool", command], root, environment);
  return status;
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "install") {
    return install(parsed.profile);
  }
  if (parsed.command === "build") {
    return build(parsed.profile);
  }
  const before = await build(parsed.profile);
  return before === 0 ? execute(parsed.profile, parsed.command) : before;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
