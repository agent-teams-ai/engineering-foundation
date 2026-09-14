import { createSourceArchitecturePolicyReader, createSourceCensusReader } from "../capabilities/source-dependencies/module.js";
import { createSuppressionPolicyReader } from "../capabilities/suppression-governance/module.js";
import { loadStrictYamlFile } from "../features/configuration-input/node.js";
import { readContainedRegularFile } from "../source-inventory/node.js";
import { createWorkspaceInventoryReader } from "../workspace-inventory/module.js";
import { assertSchema } from "../schema-catalog.js";
import { createQualityConfigurationReader, createQualityCoverageReader, createQualityToolProvider } from "../features/quality-coverage/node.js";
import { createQualityCoverageCapability, createQualityCoverageCommand } from "../features/quality-coverage/api.js";
import type { ManagedProcessExecutor } from "../process-execution/api.js";

const ports = {
  census: createSourceCensusReader({ read: readContainedRegularFile }),
  inventory: createWorkspaceInventoryReader(),
  authority: {
    source: createSourceArchitecturePolicyReader({ readYaml: loadStrictYamlFile, assertSchema }),
    suppressions: createSuppressionPolicyReader({ readYaml: loadStrictYamlFile, assertSchema })
  }
};
const configuration = createQualityConfigurationReader(loadStrictYamlFile, assertSchema);
const reader = createQualityCoverageReader(ports, configuration, readContainedRegularFile);
export const qualityCoverageCapability = createQualityCoverageCapability(reader);

export function createQualityCommand(executor: ManagedProcessExecutor, nodeExecutable: string, environment: Readonly<Record<string, string | undefined>>) {
  return createQualityCoverageCommand(reader, createQualityToolProvider({
    ports, configuration, readFile: readContainedRegularFile, executor, nodeExecutable, environment
  }));
}
