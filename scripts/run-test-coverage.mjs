import { spawn } from "node:child_process";

import { repositoryRoot, validateTestManifests } from "./check-test-manifests.mjs";

const manifest = await validateTestManifests();
const child = spawn(process.execPath, [
  "--test",
  "--test-concurrency=1",
  "--experimental-test-coverage",
  "--test-coverage-include=packages/engineering-foundation/dist/**/*.js",
  "--test-coverage-exclude=packages/engineering-foundation/dist/**/*.d.ts",
  "--test-coverage-lines=36",
  "--test-coverage-branches=67",
  "--test-coverage-functions=42",
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
