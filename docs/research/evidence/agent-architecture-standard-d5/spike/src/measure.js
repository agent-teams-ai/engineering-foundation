import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { preChangeComparison } from "./workflow.js";
import { validateOverlay } from "./operations.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scenarios = JSON.parse(await readFile(join(root, "fixtures", "scenarios.json"), "utf8"));
const iterations = 1000;
const started = performance.now();
let rows;
for (let index = 0; index < iterations; index += 1) {
  rows = scenarios.map((scenario) => {
    const comparison = preChangeComparison(scenario);
    const overlay = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay });
    return {
      id: scenario.id,
      representative: scenario.representative,
      actionableGain: comparison.actionableGain,
      actions: comparison.distinctActions,
      overlayResolution: overlay.resolution,
      overlayVerdict: overlay.verdict ?? null,
      overlayReason: overlay.reason
    };
  });
}
const elapsedMs = performance.now() - started;

async function sourceLoc(directory) {
  const names = await readdir(directory, { withFileTypes: true });
  let lines = 0;
  for (const name of names) {
    const path = join(directory, name.name);
    if (name.isDirectory()) lines += await sourceLoc(path);
    else if (name.name.endsWith(".js")) {
      const content = await readFile(path, "utf8");
      lines += content.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//")).length;
    }
  }
  return lines;
}

const representativeGains = rows.filter((row) => row.representative && row.actionableGain).length;
const report = {
  iterations,
  totalScenarioRuns: iterations * scenarios.length,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  meanMicrosecondsPerScenario: Number((elapsedMs * 1000 / (iterations * scenarios.length)).toFixed(3)),
  implementationAndTestLoc: await sourceLoc(root),
  representativeGains,
  behavioralNonOverlapRequiresTestSuite: true,
  numericalGainThresholdPassed: representativeGains >= 2,
  rows
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
