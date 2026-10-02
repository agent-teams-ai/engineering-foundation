import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot, selectTestPathsForPlatform, validateTestManifests } from "./check-test-manifests.mjs";
import { requireContainedRealDirectory, writeShardEvidence } from "./coverage-evidence.mjs";
import { maybeRunMandatoryNodeTests } from "./mandatory-node-test.mjs";
import { attachTestTiming } from "./test-timing.mjs";

const usage = "Usage: node scripts/run-test-shard.mjs --shards <ids> [--coverage-evidence-dir <path> --head-sha <sha>] [--timing-output <dir>]";

function inside(directory, root) {
  const path = relative(root, directory);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function rejectCoverageTiming(timingDirectory, evidenceDirectory, coverageRoot = resolvePath(repositoryRoot, ".coverage-evidence")) {
  if (timingDirectory !== undefined &&
    [coverageRoot, evidenceDirectory].filter(Boolean)
      .some((directory) => inside(timingDirectory, directory))) {
    throw new Error("Timing output must be outside the coverage evidence directory");
  }
}

async function realDirectoryAncestor(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) { return path; }
    return resolvePath(await realDirectoryAncestor(dirname(path)), relative(dirname(path), path));
  }
}

export function parseTestShardArguments(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map();
  for (let index = 0; index < normalizedArguments.length; index += 2) {
    const key = normalizedArguments[index];
    const value = normalizedArguments[index + 1];
    if (!new Set(["--shards", "--coverage-evidence-dir", "--head-sha", "--timing-output"]).has(key) || value === undefined) {
      throw new Error(usage);
    }
    if (values.has(key)) {
      throw new Error(`Duplicate argument ${key}`);
    }
    values.set(key, value);
  }
  const shardValue = values.get("--shards");
  if (shardValue === undefined) {
    throw new Error(usage);
  }
  const ids = shardValue.split(",");
  if (ids.some((id) => !/^[1-4]$/u.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Shard ids must be unique values from 1 through 4");
  }
  const evidencePath = values.get("--coverage-evidence-dir");
  const headSha = values.get("--head-sha");
  if ((evidencePath === undefined) !== (headSha === undefined)) {
    throw new Error("Coverage evidence directory and head SHA must be supplied together");
  }
  if (evidencePath !== undefined && ids.length !== 1) {
    throw new Error("Coverage evidence requires exactly one shard");
  }
  const evidenceDirectory =
    evidencePath === undefined ? undefined : resolvePath(repositoryRoot, evidencePath);
  if (
    evidenceDirectory !== undefined &&
    !evidenceDirectory.startsWith(`${resolvePath(repositoryRoot)}${sep}`)
  ) {
    throw new Error("Coverage evidence directory must be inside the repository");
  }
  const timingPath = values.get("--timing-output");
  const timingDirectory = timingPath === undefined ? undefined : resolvePath(repositoryRoot, timingPath);
  rejectCoverageTiming(timingDirectory, evidenceDirectory);
  return Object.freeze({ evidenceDirectory, headSha, ids, timingDirectory });
}

export function selectTestShardPaths(manifest, ids, coverageEvidenceEnabled, platform = process.platform,
  architecture = process.arch) {
  if (coverageEvidenceEnabled && (platform !== "linux" || architecture !== "x64")) {
    throw new Error("Raw coverage qualification requires the complete Linux selection on linux/x64");
  }
  const selectedShards = coverageEvidenceEnabled ? manifest.coverageShards : manifest.shards;
  return selectTestPathsForPlatform(manifest, ids.flatMap((id) => selectedShards.get(id) ?? []),
    platform, architecture);
}

async function main() {
  const manifest = await validateTestManifests();
  const { evidenceDirectory, headSha, ids, timingDirectory } = parseTestShardArguments(process.argv.slice(2));
  const tests = selectTestShardPaths(manifest, ids, evidenceDirectory !== undefined);
  const activeEvidenceDirectory = await prepareEvidenceDirectory(evidenceDirectory);
  const bootstrapUrl = new URL("./coverage-process-bootstrap.mjs", import.meta.url).href;
  const mandatoryOptions = activeEvidenceDirectory === undefined ? {} : {
      execArgv: ["--import", bootstrapUrl],
      env: { ...process.env, NODE_V8_COVERAGE: joinEvidencePath(activeEvidenceDirectory, "raw") },
    };
  const exitCode = await runTestShardTests(tests, { runOptions: mandatoryOptions, timingDirectory, evidenceDirectory });
  if (exitCode === 0 && activeEvidenceDirectory !== undefined) {
    try {
      await writeShardEvidence({ directory: activeEvidenceDirectory, headSha, shardId: ids[0] });
    } catch (error) {
      process.stderr.write(`Coverage evidence finalization is advisory: ${String(error)}\n`);
    }
  }
  process.exitCode = exitCode;
}

export async function runTestShardTests(tests, { runOptions = {}, timingDirectory, evidenceDirectory } = {}, root = repositoryRoot) {
  if (timingDirectory !== undefined) {
    rejectCoverageTiming(await realDirectoryAncestor(timingDirectory),
      evidenceDirectory === undefined ? undefined : await realDirectoryAncestor(evidenceDirectory),
      await realDirectoryAncestor(resolvePath(root, ".coverage-evidence")));
  }
  const records = [];
  const options = timingDirectory === undefined ? runOptions : {
    ...runOptions,
    setup(stream) {
      const result = runOptions.setup?.(stream);
      attachTestTiming(stream, (record) => records.push(record));
      return result;
    },
  };
  const mandatoryExit = await maybeRunMandatoryNodeTests(tests, options, root);
  const exitCode = mandatoryExit ?? await spawnTestShard(tests, runOptions, timingDirectory, records, root);
  if (timingDirectory !== undefined) {
    try {
      await mkdir(timingDirectory, { recursive: true });
      await writeFile(resolvePath(timingDirectory, "events.jsonl"),
        records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    } catch (error) {
      process.stderr.write(`Test timing is advisory: ${String(error)}\n`);
    }
  }
  return exitCode;
}

async function spawnTestShard(tests, runOptions, timingDirectory, records, root) {
  const childArguments = [
    ...(runOptions.execArgv ?? []),
    "--test",
    // Emit failure details immediately, including when CI later times out.
    "--test-reporter=tap",
    ...(timingDirectory === undefined ? [] : ["--test-reporter-destination=stdout",
      `--test-reporter=${new URL("./test-timing.mjs", import.meta.url).href}`,
      "--test-reporter-destination=stdout"]),
    "--test-concurrency=1",
    ...tests,
  ];
  const child = spawn(process.execPath, childArguments, {
    cwd: root,
    env: runOptions.env ?? process.env,
    stdio: timingDirectory === undefined ? "inherit" : ["inherit", "inherit", "inherit", "ipc"],
  });
  child.on("message", (message) => {
    try { if (message?.type === "foundation:test-timing") { records.push(message.record); } }
    catch { /* Advisory observation only. */ }
  });
  child.once("error", (error) => {
    throw error;
  });
  const exitCode = await new Promise((resolve) => {
    child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  return exitCode;
}

async function prepareEvidenceDirectory(evidenceDirectory) {
  if (evidenceDirectory === undefined) {
    return;
  }
  try {
    const parentDirectory = dirname(evidenceDirectory);
    await mkdir(parentDirectory, { recursive: true });
    await requireContainedRealDirectory(
      parentDirectory,
      repositoryRoot,
      "coverage evidence parent directory",
    );
    await mkdir(evidenceDirectory);
    await mkdir(joinEvidencePath(evidenceDirectory, "raw"));
    return evidenceDirectory;
  } catch (error) {
    process.stderr.write(`Coverage evidence setup is advisory: ${String(error)}\n`);
    return;
  }
}

function joinEvidencePath(directory, child) {
  return resolvePath(directory, child);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
