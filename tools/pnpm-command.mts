import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { firstExisting, isRegularFile, verifyQualificationNode } from "./executable-policy.mts";
import { readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";

const allowedArguments = [
  ["--version"],
  ["peers", "check", "--lockfile-only"]
] as const;

function matchesArguments(args: readonly string[]): boolean {
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
    args.length === 4 &&
    args[0] === "install" &&
    args[1] === "--frozen-lockfile" &&
    args[2] === "--ignore-scripts" &&
    args[3] === "--engine-strict"
  ) {
    return true;
  }
  return allowedArguments.some((allowed) =>
    allowed.length === args.length &&
    allowed.every((value, index) => value === args[index])
  );
}

function observesPnpmVersion(
  node: string,
  entrypoint: string,
  expectedVersion: string
): boolean {
  const observation = spawnSync(node, [
    entrypoint,
    "--pm-on-fail=ignore",
    "--version"
  ], { encoding: "utf8", timeout: 10_000 });
  return observation.status === 0 &&
    observation.stdout.trim() === expectedVersion &&
    observation.stderr.trim() === "";
}

function isJavaScriptEntrypoint(path: string): boolean {
  return /\.(?:c|m)?js$/u.test(path);
}

async function pnpmEntrypoint(node: string, expectedVersion: string): Promise<string> {
  const explicit = process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
  if (explicit !== undefined) {
    if (!await isRegularFile(explicit)) {
      throw new Error("The explicit pnpm entrypoint is unavailable.");
    }
    const selected = await realpath(explicit);
    if (!isJavaScriptEntrypoint(selected)) {
      throw new Error("The explicit pnpm entrypoint is not a JavaScript entrypoint.");
    }
    if (!observesPnpmVersion(node, selected, expectedVersion)) {
      throw new Error(`The explicit manager is not pnpm ${expectedVersion}.`);
    }
    return selected;
  }
  const candidates = (process.env["PATH"] ?? "").split(delimiter)
    .filter((path) => path.length > 0)
    .flatMap((path) => [
      resolve(path, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
      resolve(path, "pnpm.mjs"),
      resolve(path, "pnpm.cjs")
    ]);
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) {
      const selected = await realpath(candidate);
      if (isJavaScriptEntrypoint(selected) && observesPnpmVersion(node, selected, expectedVersion)) {
        return selected;
      }
    }
  }
  throw new Error(`No admitted pnpm ${expectedVersion} entrypoint was found on PATH.`);
}

async function verifiedNode(): Promise<string> {
  return verifyQualificationNode(await firstExisting([
    process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"],
    process.versions["bun"] === undefined ? process.execPath : undefined,
    ...((process.env["PATH"] ?? "").split(delimiter)
      .filter((path) => path.length > 0)
      .map((path) => resolve(path, process.platform === "win32" ? "node.exe" : "node")))
  ]));
}

const args = process.argv.slice(2);
if (!matchesArguments(args)) {
  throw new Error("pnpm-command accepts only the closed pinned pnpm operations.");
}
const pnpmArguments = ["--pm-on-fail=ignore", ...args];
const policy = await readRepositoryRuntimePolicy(repositoryRoot);
const node = await verifiedNode();
const entrypoint = await pnpmEntrypoint(node, policy.toolchain.pnpm.version);
const result = spawnSync(node, [entrypoint, ...pnpmArguments], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
