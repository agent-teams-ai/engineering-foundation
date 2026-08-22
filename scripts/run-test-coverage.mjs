import { spawn } from "node:child_process";

import { repositoryRoot, validateTestManifests } from "./check-test-manifests.mjs";

const manifest = await validateTestManifests();
const config = manifest.coverageConfig;
const child = spawn(process.execPath, [
  "--test",
  "--test-concurrency=1",
  "--experimental-test-coverage",
  ...config.include.map((pattern) => `--test-coverage-include=${pattern}`),
  ...config.exclude.map((pattern) => `--test-coverage-exclude=${pattern}`),
  `--test-coverage-lines=${config.thresholds.lines}`,
  `--test-coverage-branches=${config.thresholds.branches}`,
  `--test-coverage-functions=${config.thresholds.functions}`,
  ...manifest.coverageTests,
], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
child.once("error", (error) => {
  throw error;
});
const exitCode = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
});
process.exitCode = exitCode;
