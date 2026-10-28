import { createSourceCensusReader } from "../capabilities/source-dependencies/module.js";
import {
  loadQualityGatePolicy,
  performanceMonotonicClock,
} from "../capabilities/quality-gate-runner/module.js";
import { createNodeQualityGateCommand } from "../capabilities/quality-gate-runner/command-module.js";
import { loadStrictYamlFile } from "../features/configuration-input/node.js";
import { readContainedRegularFile } from "../source-inventory/node.js";
import { assertSchema } from "../schema-catalog.js";
import {
  checkFormatCoverage,
  createFormatCoverageCapability,
} from "../features/quality-coverage/api.js";
import {
  createFormatObservations,
  createFormatAuthorityExecution,
} from "../features/quality-coverage/node.js";
import { createLiteralFormatter } from "../features/quality-coverage/adapters/format-toolchain.js";
import type { ManagedProcessExecutor } from "../process-execution/api.js";

const readGates = (root: string, path: string, signal?: AbortSignal) =>
  loadQualityGatePolicy({ readYaml: loadStrictYamlFile, assertSchema }, root, path, signal);
const observations = createFormatObservations({
  census: createSourceCensusReader({ read: readContainedRegularFile }),
  readFile: readContainedRegularFile,
  readYaml: loadStrictYamlFile,
  assertSchema,
  readGates,
});
const staticPorts = {
  ...observations,
  nowMs: performanceMonotonicClock.nowMs,
  prepareFormatter: createLiteralFormatter(readContainedRegularFile),
};
export const formatCoverageCapability = createFormatCoverageCapability(staticPorts);

export function createFormatCommand(
  executor: ManagedProcessExecutor,
  environment: Readonly<NodeJS.ProcessEnv>,
) {
  const execution = createFormatAuthorityExecution(
    createNodeQualityGateCommand(environment, executor, assertSchema),
    environment.AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE !== undefined,
  );
  return (input: Parameters<typeof checkFormatCoverage>[0]) =>
    checkFormatCoverage(input, { ...staticPorts, execution });
}
