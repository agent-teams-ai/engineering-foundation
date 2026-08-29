import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot, validateTestManifests } from "./check-test-manifests.mjs";

export function builtTestArguments(manifest) {
  if (!Array.isArray(manifest?.tests) || manifest.tests.length === 0) {
    throw new Error("Built test runner requires a non-empty validated test inventory.");
  }
  return Object.freeze([
    "--test",
    "--test-concurrency=1",
    ...manifest.tests,
  ]);
}

export async function runBuiltTests({ spawnChild = spawn } = {}) {
  const manifest = await validateTestManifests();
  const child = spawnChild(process.execPath, builtTestArguments(manifest), {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTermination = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve(code ?? (signal === null ? 1 : 128)));
    });
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
  }
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolvePath(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  process.exitCode = await runBuiltTests();
}
