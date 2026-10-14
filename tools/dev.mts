import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { assertBunRootProjection, readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";

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
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env: environment, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Command terminated by ${signal}.`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

async function executable(profile: Profile): Promise<{ readonly node: string; readonly bun?: string; readonly manager: string }> {
  const policy = await readRepositoryRuntimePolicy();
  const node = process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"] ??
    (process.versions["bun"] === undefined ? process.execPath : "/opt/nodejs/node-v26.11.1-linux-x64/bin/node");
  const bun = process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"] ??
    resolve(repositoryRoot, "node_modules/.job-scratch/toolchains/bun/bun-linux-x64/bun");
  const manager = profile === "bun" ? bun : resolve(repositoryRoot, "tools/pnpm-command.mts");
  if (policy.defaultProfile !== "bun") {
    throw new Error("Runtime policy default profile drifted.");
  }
  return { node, ...(profile === "bun" ? { bun } : {}), manager };
}

async function freshProfileRoot(profile: Profile): Promise<string> {
  const requested = process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"];
  if (profile === "bun" && requested === undefined) {
    const installed = resolve(repositoryRoot, "node_modules");
    const entries: string[] = await readdir(installed).catch((): string[] => []);
    if (entries.includes(".pnpm") || entries.includes(".bun")) {
      throw new Error("Bun install refuses a mixed existing node_modules; use a profile-owned TEST root.");
    }
    return repositoryRoot;
  }
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const target = requested ?? resolve(repositoryRoot, `.worker-tmp/profiles/${profile}-${sourceSha}`);
  if (!resolve(target).startsWith(resolve(repositoryRoot, ".worker-tmp/"))) {
    throw new Error(`${profile} install requires a profile-owned root beneath .worker-tmp.`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const copyTree = async (source: string, destination: string): Promise<void> => {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".worker-tmp" || entry.name === ".pnpm-store") {
        continue;
      }
      const from = resolve(source, entry.name);
      const to = resolve(destination, entry.name);
      if (entry.isDirectory()) {
        await copyTree(from, to);
      } else if (entry.isFile()) {
        await copyFile(from, to);
      }
    }
  };
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
    const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
    manifest["packageManager"] = `pnpm@${policy.toolchain.pnpm.version}`;
    await writeFile(resolve(profileRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const derivedDigest = createHash("sha256").update(JSON.stringify(manifest, null, 2) + "\n").digest("hex");
    await writeProfileEvidence(profileRoot, profile, sourceSha, originalDigest, derivedDigest);
  } else {
    await writeProfileEvidence(profileRoot, profile, sourceSha, originalDigest, originalDigest);
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
    const qualified = await run(tools.node, [resolve(profileRoot, "tools/qualify-native-tools.mts")], profileRoot);
    return qualified === 0
      ? run(tools.node, [resolve(profileRoot, "tools/dependencies-installed-check.mts")], profileRoot, {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_INSTALLED_INVENTORY: resolve(profileRoot, ".worker-tmp/installed-dependencies.json")
        })
      : qualified;
  }
  return run(tools.node, [tools.manager, "peers", "check", "--lockfile-only"], profileRoot);
}

async function writeProfileEvidence(
  root: string,
  profile: Profile,
  sourceSha: string,
  originalManifestSha256: string,
  derivedManifestSha256: string
): Promise<void> {
  await writeFile(resolve(root, ".agent-teams-runtime-profile.json"), `${JSON.stringify({
    profile, sourceSha, originalManifestSha256, derivedManifestSha256
  }, null, 2)}\n`, "utf8");
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

const parsed = parseArguments(process.argv.slice(2));
if (parsed.command === "install") {
  process.exitCode = await install(parsed.profile);
} else if (parsed.command === "build") {
  process.exitCode = await build(parsed.profile);
} else {
  const before = await build(parsed.profile);
  process.exitCode = before === 0 ? await execute(parsed.profile, parsed.command) : before;
}
