import {
  createSourceArchitecturePolicyReader,
  createSourceCensusReader,
} from "../capabilities/source-dependencies/module.js";
import { createSuppressionPolicyReader } from "../capabilities/suppression-governance/module.js";
import {
  loadStrictYamlFile,
  createStrictYamlFileLoader,
} from "../features/configuration-input/node.js";
import { readContainedRegularFile } from "../source-inventory/node.js";
import { createWorkspaceInventoryReader } from "../workspace-inventory/module.js";
import { assertSchema } from "../schema-catalog.js";
import {
  createQualityConfigurationReader,
  createQualityCoverageReader,
  createQualityToolProvider,
} from "../features/quality-coverage/node.js";
import {
  createQualityCoverageCapability,
  createQualityCoverageCommand,
  type QualityFileReader,
} from "../features/quality-coverage/api.js";
import type { ManagedProcessExecutor } from "../process-execution/api.js";

function observedPorts(read: QualityFileReader, readYaml: typeof loadStrictYamlFile) {
  return {
    census: createSourceCensusReader({ read }),
    inventory: createWorkspaceInventoryReader({ read, readYaml }),
    authority: {
      source: createSourceArchitecturePolicyReader({ readYaml, assertSchema }),
      suppressions: createSuppressionPolicyReader({ readYaml, assertSchema }),
    },
  };
}
const configuration = createQualityConfigurationReader(assertSchema, createStrictYamlFileLoader);
const reader = createQualityCoverageReader(
  observedPorts(readContainedRegularFile, loadStrictYamlFile),
  configuration,
  readContainedRegularFile,
  observedPorts,
);
export const qualityCoverageCapability = createQualityCoverageCapability(reader);

export function createQualityCommand(
  executor: ManagedProcessExecutor,
  nodeExecutable: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return createQualityCoverageCommand(
    reader,
    createQualityToolProvider({
      executor,
      nodeExecutable,
      environment,
    }),
  );
}
