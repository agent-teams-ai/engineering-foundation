import { spawn } from "node:child_process";

import { repositoryRoot, selectTestPathsForPlatform, validateTestManifests } from "./check-test-manifests.mjs";
import { partitionGeneration2Tests, resolveGeneration2Node } from "./generation2-node.mts";
import { maybeRunMandatoryNodeTests } from "./mandatory-node-test.mjs";

const manifest = await validateTestManifests();
const config = manifest.coverageConfig;
const { current, legacy } = partitionGeneration2Tests(selectTestPathsForPlatform(manifest, manifest.coverageTests));
// Fail before any test starts when the explicit Node 24 is unavailable.
const legacyNode = legacy.length > 0 ? await resolveGeneration2Node() : undefined;

async function runNode(node, flags, tests) {
  const child = spawn(node, ["--test", "--test-concurrency=1", "--experimental-test-coverage",
    ...config.include.map((pattern) => `--test-coverage-include=${pattern}`),
    ...config.exclude.map((pattern) => `--test-coverage-exclude=${pattern}`),
    ...flags,
    ...tests,
  ], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    throw error;
  });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}

const mandatoryExit = await maybeRunMandatoryNodeTests(current, {
  coverage: true,
  coverageIncludeGlobs: config.include,
  coverageExcludeGlobs: config.exclude,
  lineCoverage: config.thresholds.lines,
  branchCoverage: config.thresholds.branches,
  functionCoverage: config.thresholds.functions,
});
let exitCode = mandatoryExit ?? (current.length === 0 ? 0 : await runNode(process.execPath, [
  `--test-coverage-lines=${config.thresholds.lines}`,
  `--test-coverage-branches=${config.thresholds.branches}`,
  `--test-coverage-functions=${config.thresholds.functions}`,
], current));
if (legacyNode !== undefined) {
  // Managed generation2 suites run on the explicit Node 24 and still collect coverage with the same
  // include/exclude globs. Node enforces floors per process and cannot merge processes, so this lane
  // reports without a floor; the blocking authority is the partitioned shard evidence.
  // Always dispatch the legacy lane, even after a current failure; keep the first nonzero code.
  const legacyExit = await runNode(legacyNode, [], legacy);
  exitCode ||= legacyExit;
}
process.exitCode = exitCode;
