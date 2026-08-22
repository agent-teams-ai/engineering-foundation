import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { repositoryRoot, validateTestManifests } from "./check-test-manifests.mjs";
import { writeShardEvidence } from "./coverage-evidence.mjs";

export function parseTestShardArguments(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map();
  for (let index = 0; index < normalizedArguments.length; index += 2) {
    const key = normalizedArguments[index];
    const value = normalizedArguments[index + 1];
    if (!new Set(["--shards", "--coverage-evidence-dir", "--head-sha"]).has(key) || value === undefined) {
      throw new Error("Usage: node scripts/run-test-shard.mjs --shards <ids> [--coverage-evidence-dir <path> --head-sha <sha>]");
    }
    if (values.has(key)) {
      throw new Error(`Duplicate argument ${key}`);
    }
    values.set(key, value);
  }
  const shardValue = values.get("--shards");
  if (shardValue === undefined) {
    throw new Error("Usage: node scripts/run-test-shard.mjs --shards <ids> [--coverage-evidence-dir <path> --head-sha <sha>]");
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
  return Object.freeze({ evidenceDirectory, headSha, ids });
}

async function main() {
  const manifest = await validateTestManifests();
  const { evidenceDirectory, headSha, ids } = parseTestShardArguments(process.argv.slice(2));
  const tests = ids.flatMap((id) => manifest.shards.get(id) ?? []);
  const activeEvidenceDirectory = await prepareEvidenceDirectory(evidenceDirectory);
  const bootstrapPath = fileURLToPath(new URL("./coverage-process-bootstrap.mjs", import.meta.url));
  const childArguments = [
    ...(activeEvidenceDirectory === undefined ? [] : ["--import", bootstrapPath]),
    "--test",
    "--test-concurrency=1",
    ...tests,
  ];
  const child = spawn(process.execPath, childArguments, {
    cwd: repositoryRoot,
    env:
      activeEvidenceDirectory === undefined
        ? process.env
        : { ...process.env, NODE_V8_COVERAGE: joinEvidencePath(activeEvidenceDirectory, "raw") },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    throw error;
  });
  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  if (exitCode === 0 && activeEvidenceDirectory !== undefined) {
    try {
      await writeShardEvidence({ directory: activeEvidenceDirectory, headSha, shardId: ids[0] });
    } catch (error) {
      process.stderr.write(`Coverage evidence finalization is advisory: ${String(error)}\n`);
    }
  }
  process.exitCode = exitCode;
}

async function prepareEvidenceDirectory(evidenceDirectory) {
  if (evidenceDirectory === undefined) {
    return;
  }
  try {
    await mkdir(dirname(evidenceDirectory), { recursive: true });
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
