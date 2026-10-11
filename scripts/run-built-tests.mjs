import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot, selectTestPathsForPlatform, validateTestManifests } from "./check-test-manifests.mjs";
import { partitionGeneration2Tests, resolveGeneration2Node } from "./generation2-node.mts";
import { maybeRunMandatoryNodeTests } from "./mandatory-node-test.mjs";

export function builtTestArguments(manifest) {
  if (!Array.isArray(manifest?.tests) || manifest.tests.length === 0) {
    throw new Error("Built test runner requires a non-empty validated test inventory.");
  }
  return Object.freeze(["--test", "--test-concurrency=1", ...manifest.tests]);
}

async function runChild(spawnChild, node, tests) {
  const child = spawnChild(node, builtTestArguments({ tests }), {
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
      child.once("exit", (code, signal) => {
        if (code !== null) {
          resolve(code);
          return;
        }
        resolve(signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0));
      });
    });
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
  }
}

// Managed generation2 suites run in their own process on the explicit Node 24; everything else
// (including mandatory observation) stays on the default interpreter.
export async function runPartitionedBuiltTests(tests, { spawnChild = spawn, runMandatory = maybeRunMandatoryNodeTests } = {}) {
  const { current, legacy } = partitionGeneration2Tests(tests);
  // Fail before any test starts when the explicit Node 24 is unavailable.
  const legacyNode = legacy.length > 0 ? await resolveGeneration2Node() : undefined;
  const mandatoryExit = await runMandatory(current);
  let exitCode = mandatoryExit ?? (current.length === 0 ? 0 : await runChild(spawnChild, process.execPath, current));
  if (legacyNode !== undefined) {
    // Always dispatch the legacy lane, even after a current failure; keep the first nonzero code.
    const legacyExit = await runChild(spawnChild, legacyNode, legacy);
    exitCode ||= legacyExit;
  }
  return exitCode;
}

export async function runBuiltTests(options = {}) {
  const manifest = await validateTestManifests();
  return runPartitionedBuiltTests(selectTestPathsForPlatform(manifest, manifest.tests), options);
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  process.exitCode = await runBuiltTests();
}
