import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

const pairs = [["1", "2"], ["3", "4"], ["5", "6"], ["7", "8"]] as const;

function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", [...args], {
      cwd, stdio: "inherit",
      env,
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === null) { reject(new Error(`Producer terminated by ${signal}.`)); }
      else { resolve(status); }
    });
  });
}

async function ciContext() {
  if (process.platform !== "linux") { throw new Error("Linux CI producers require Linux."); }
  const head = process.env.GITHUB_SHA;
  const temporary = process.env.RUNNER_TEMP;
  const output = process.env.GITHUB_OUTPUT;
  if (!head || !/^[a-f0-9]{40}$/u.test(head) || !temporary || !isAbsolute(temporary) || !output) {
    throw new Error("CI producers require the declared head and runner paths.");
  }
  if (await realpath(temporary) !== resolvePath(temporary) || !(await lstat(temporary)).isDirectory()) {
    throw new Error("CI producers require a physical runner temporary directory.");
  }
  return { head, temporary, output };
}

// Two fixed producers, with separate Git trees, builds and raw evidence. There
// is no shared test process, dist directory, archive or coverage directory.
export async function runCiTestPair(args: readonly string[]): Promise<void> {
  const phase = args[0];
  const pair = pairs.find(([first, second]) => first === args[1] && second === args[2]);
  if (args.length !== 3 || (phase !== "build" && phase !== "test") || !pair) {
    throw new Error("Usage: run-ci-test-pair.mts build|test 1 2|3 4|5 6|7 8");
  }
  const { head, temporary, output } = await ciContext();
  const roots = [resolvePath("producer-a"), resolvePath("producer-b")];
  const entries = await Promise.all(roots.map(root => lstat(root)));
  const physical = await Promise.all(roots.map(root => realpath(root)));
  if (entries.some(entry => !entry.isDirectory()) ||
      physical.some((root, index) => root !== roots[index]) || physical[0] === physical[1]) {
    throw new Error("CI producers require distinct physical checkout roots.");
  }
  const temporaryRoots = pair.map(shard => join(temporary, `producer-${shard}`));
  await Promise.all(temporaryRoots.map(async root => {
    try { await mkdir(root); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") ||
          !(await lstat(root)).isDirectory()) { throw error; }
    }
  }));
  if ((await Promise.all(temporaryRoots.map(root => realpath(root))))
    .some((root, index) => root !== temporaryRoots[index])) {
    throw new Error("CI producers require physical temporary roots.");
  }
  const statuses: Array<number | undefined> = [undefined, undefined];
  // allSettled drains both started children even if the other producer fails.
  const results = await Promise.allSettled(pair.map(async (shard, index) => {
    const temporaryRoot = temporaryRoots[index];
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1",
      RUNNER_TEMP: temporaryRoot, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot };
    if (shard !== "4") {
      delete env.MANAGED_TEST_TOOLS_ROOT;
      delete env.MANAGED_TEST_ROOT;
      delete env.MANAGED_TEST_NODE26_SOURCE;
    }
    const commands = phase === "build"
      ? [["install", "--frozen-lockfile", "--ignore-scripts"], ["rebuild"], ["build"]]
      : [["test:shard:built", "--", "--shards", shard,
          "--coverage-evidence-dir", `.coverage-evidence/shard-${shard}`,
          "--head-sha", head, "--timing-output", join(temporaryRoot, "test-timing", `linux-test-${shard}`)]];
    for (const command of commands) {
      statuses[index] = undefined;
      const status = await run(command, roots[index], env);
      statuses[index] = status;
      if (status !== 0) { throw new Error(`Linux producer ${shard} ${phase} exited ${status}.`); }
    }
  }));
  await appendFile(output, `first-status=${statuses[0] ?? "error"}\nsecond-status=${statuses[1] ?? "error"}\n`);
  for (const result of results) {
    if (result.status === "rejected") { throw result.reason; }
  }
}

if (import.meta.main) {
  try { await runCiTestPair(process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
