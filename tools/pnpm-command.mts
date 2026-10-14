import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

const allowedArguments = [
  ["--version"],
  ["peers", "check", "--lockfile-only"]
] as const;

function matchesArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length === 2 && arguments_[0] === "run" && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(arguments_[1] ?? "")) {
    return true;
  }
  if (
    arguments_.length === 5 &&
    arguments_[0] === "--filter" &&
    arguments_[1] === "@agent-teams/source-dependency-parser-spike" &&
    arguments_[2] === "run" &&
    (arguments_[3] === "check" || arguments_[3] === "spike")
  ) {
    return true;
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "install" &&
    arguments_[1] === "--frozen-lockfile" &&
    arguments_[2] === "--ignore-scripts" &&
    arguments_[3] === "--engine-strict"
  ) {
    return true;
  }
  return allowedArguments.some((allowed) =>
    allowed.length === arguments_.length &&
    allowed.every((value, index) => value === arguments_[index])
  );
}

async function regularFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  return metadata?.isFile() === true;
}

async function pnpmEntrypoint(): Promise<string> {
  const candidates = [
    process.env["npm_execpath"],
    resolve(import.meta.dirname, "../node_modules/.job-scratch/toolchains/pnpm/bin/pnpm.mjs"),
    ...(process.env["PATH"] ?? "").split(delimiter)
      .filter((path) => path.length > 0)
      .flatMap((path) => [resolve(path, "pnpm.mjs"), resolve(path, "pnpm.cjs")])
  ];
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      isAbsolute(candidate) &&
      /\.(?:c|m)?js$/u.test(candidate) &&
      await regularFile(candidate)
    ) {
      return await realpath(candidate);
    }
  }
  throw new Error("The pinned pnpm JavaScript entrypoint is unavailable.");
}

async function verifiedNode(): Promise<string> {
  const candidate = process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"] ??
    (process.versions["bun"] === undefined ? process.execPath : resolve("/opt/nodejs/node-v26.11.1-linux-x64/bin/node"));
  if (!isAbsolute(candidate) || !await regularFile(candidate)) {
    throw new Error("The explicit Node qualification executable is unavailable.");
  }
  const observation = spawnSync(candidate, ["-p", "JSON.stringify({execPath:process.execPath,version:process.versions.node})"], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (observation.status !== 0) {
    throw new Error("The explicit Node qualification executable did not run.");
  }
  const observed = JSON.parse(observation.stdout) as { readonly execPath: string; readonly version: string };
  if (
    observed.version !== "26.11.1" ||
    await realpath(observed.execPath) !== await realpath(candidate) ||
    !/(?:^|[\\/])node(?:\.exe)?$/u.test(observed.execPath)
  ) {
    throw new Error("The admitted Node qualification executable is not real Node 26.11.1.");
  }
  return candidate;
}

const arguments_ = process.argv.slice(2);
if (!matchesArguments(arguments_)) {
  throw new Error("pnpm-command accepts only the closed pinned pnpm operations.");
}
const pnpmArguments = arguments_[0] === "peers"
  ? ["--pm-on-fail=ignore", ...arguments_]
  : arguments_;
const result = spawnSync(await verifiedNode(), [await pnpmEntrypoint(), ...pnpmArguments], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
