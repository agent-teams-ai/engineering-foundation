import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstExisting, isRegularFile, verifyQualificationNode } from "./executable-policy.mts";
import { readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";

const allowedArguments = [
  ["--version"],
  ["peers", "check", "--lockfile-only"]
] as const;

function isReadOnlyPack(args: readonly string[]): boolean {
  const output = args[2];
  return args.length === 3 && args[0] === "pack" && args[1] === "--out" &&
    output !== undefined && isAbsolute(output) && output.endsWith(".tgz");
}

function matchesArguments(args: readonly string[]): boolean {
  if (isReadOnlyPack(args)) { return true; }
  if (args.length === 2 && args[0] === "run" && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(args[1] ?? "")) {
    return true;
  }
  if (
    args.length === 4 &&
    args[0] === "--filter" &&
    args[1] === "@agent-teams/source-dependency-parser-spike" &&
    args[2] === "run" &&
    (args[3] === "check" || args[3] === "spike")
  ) {
    return true;
  }
  if (
    args.length === 4 && args[0] === "install" &&
    (args[1] === "--frozen-lockfile" || args[1] === "--lockfile-only") &&
    args[2] === "--ignore-scripts" && args[3] === "--engine-strict"
  ) {
    return true;
  }
  return allowedArguments.some((allowed) =>
    allowed.length === args.length &&
    allowed.every((value, index) => value === args[index])
  );
}

function observationEnvironment(): NodeJS.ProcessEnv {
  // npm config injection is caller state, not entrypoint identity; an unresolvable
  // ${placeholder} (setup-node auth scaffolding) would otherwise contaminate stderr.
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/iu.test(key)) {
      environment[key] = value;
    }
  }
  return environment;
}

function observesPnpmVersion(
  command: string,
  entrypointArguments: readonly string[],
  expectedVersion: string
): boolean {
  const observation = spawnSync(command, [
    ...entrypointArguments,
    "--pm-on-fail=ignore",
    "--version"
  ], { encoding: "utf8", timeout: 10_000, env: observationEnvironment() });
  return observation.status === 0 &&
    observation.stdout.trim() === expectedVersion &&
    observation.stderr.trim() === "";
}

function isJavaScriptEntrypoint(path: string): boolean {
  return /\.(?:c|m)?js$/u.test(path);
}

export function pnpmPortableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "pnpm.exe" : "pnpm";
}

export interface PnpmInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly kind: "javascript" | "native";
}

function invocationForPath(path: string, node: string): PnpmInvocation | null {
  if (isJavaScriptEntrypoint(path)) {
    return { command: node, args: [path], kind: "javascript" };
  }
  return /(?:^|[\\/])pnpm(?:\.exe)?$/u.test(path)
    ? { command: path, args: [], kind: "native" }
    : null;
}

async function admittedPnpmInvocation(
  candidate: string,
  node: string,
  expectedVersion: string
): Promise<PnpmInvocation | null> {
  if (!await isRegularFile(candidate)) {
    return null;
  }
  const selected = await realpath(candidate);
  const invocation = invocationForPath(selected, node);
  if (invocation === null || !observesPnpmVersion(invocation.command, invocation.args, expectedVersion)) {
    return null;
  }
  return invocation;
}

export async function resolvePnpmInvocation(
  node: string,
  expectedVersion: string
): Promise<PnpmInvocation> {
  const explicit = process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
  if (explicit !== undefined) {
    const invocation = await admittedPnpmInvocation(explicit, node, expectedVersion);
    if (invocation === null) {
      throw new Error(`The explicit manager is not pnpm ${expectedVersion}.`);
    }
    return invocation;
  }
  const candidates = (process.env["PATH"] ?? "").split(delimiter)
    .filter((path) => path.length > 0)
    .flatMap((path) => [
      resolve(path, pnpmPortableName()),
      resolve(path, "pnpm.mjs"),
      resolve(path, "pnpm.cjs"),
      resolve(path, "pnpm.js")
    ]);
  for (const candidate of candidates) {
    const invocation = await admittedPnpmInvocation(candidate, node, expectedVersion);
    if (invocation !== null) {
      return invocation;
    }
  }
  throw new Error(`No admitted pnpm ${expectedVersion} entrypoint was found on PATH.`);
}

async function verifiedNode(): Promise<string> {
  const explicit = process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"];
  return verifyQualificationNode(explicit ?? await firstExisting([
    process.versions["bun"] === undefined ? process.execPath : undefined,
    ...((process.env["PATH"] ?? "").split(delimiter)
      .filter((path) => path.length > 0)
      .map((path) => resolve(path, process.platform === "win32" ? "node.exe" : "node")))
  ]));
}

async function assertReadOnlyPack(): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  } catch {
    throw new Error("Read-only pack requires a readable valid package manifest.");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Read-only pack requires a package manifest object.");
  }
  const scripts: unknown = Reflect.get(manifest, "scripts");
  if (scripts === undefined) { return; }
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error("Read-only pack requires a scripts object.");
  }
  for (const hook of ["prepack", "prepare", "postpack", "prepublish", "prepublishOnly"]) {
    if (Object.hasOwn(scripts, hook)) {
      throw new Error(`Read-only pack refuses lifecycle hook ${hook}.`);
    }
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (!matchesArguments(args)) {
    throw new Error("pnpm-command accepts only the closed pinned pnpm operations.");
  }
  if (args[0] === "pack") { await assertReadOnlyPack(); }
  const pnpmArguments = ["--pm-on-fail=ignore",
    ...(isReadOnlyPack(args) ? ["--config.ignore-scripts=true"] : []), ...args];
  const policy = await readRepositoryRuntimePolicy(repositoryRoot);
  const node = await verifiedNode();
  const invocation = await resolvePnpmInvocation(node, policy.toolchain.pnpm.version);
  const result = spawnSync(invocation.command, [...invocation.args, ...pnpmArguments], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(process.env["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"] === "node"
        ? { AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node" }
        : {})
    },
    stdio: "inherit"
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
