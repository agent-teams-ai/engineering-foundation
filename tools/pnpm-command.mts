import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { firstExisting, isRegularFile, verifyQualificationNode } from "./executable-policy.mts";

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

async function pnpmEntrypoint(): Promise<string> {
  const candidates = [
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"],
    process.env["npm_execpath"],
    ...(process.env["PATH"] ?? "").split(delimiter)
      .filter((path) => path.length > 0)
      .flatMap((path) => [
        resolve(path, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
        resolve(path, "pnpm.mjs"),
        resolve(path, "pnpm.cjs")
      ])
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && await isRegularFile(candidate)) {
      const canonical = await realpath(candidate);
      if (/\.(?:c|m)?js$/u.test(canonical)) {
        return canonical;
      }
    }
  }
  throw new Error("The pinned pnpm JavaScript entrypoint is unavailable.");
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
const pnpmArguments = args[0] === "peers"
  ? ["--pm-on-fail=ignore", ...args]
  : args;
const result = spawnSync(await verifiedNode(), [await pnpmEntrypoint(), ...pnpmArguments], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
