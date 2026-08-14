import { spawn } from "node:child_process";

import { validateTestManifests } from "./check-test-manifests.mjs";

function requestedShardIds(arguments_) {
  const index = arguments_.findIndex((value) => value === "--shards");
  if (index === -1 || arguments_[index + 1] === undefined) {
    throw new Error("Usage: node scripts/run-test-shard.mjs --shards <comma-separated ids>");
  }
  const ids = arguments_[index + 1].split(",");
  if (ids.some((id) => !/^[1-4]$/u.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Shard ids must be unique values from 1 through 4");
  }
  return ids;
}

const manifest = await validateTestManifests();
const ids = requestedShardIds(process.argv.slice(2));
const tests = ids.flatMap((id) => manifest.shards.get(id) ?? []);
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  cwd: process.cwd(),
  stdio: "inherit",
});
child.once("error", (error) => {
  throw error;
});
const exitCode = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
});
process.exitCode = exitCode;
