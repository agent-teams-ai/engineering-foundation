import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";
import { createOxlintSession, inspectConsumerToolchain } from "../../features/quality-coverage/node.js";
import { createManagedProcessExecutor } from "../../process-execution/module.js";
import { createSourceTreeReader } from "../../source-inventory/module.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../../source-inventory/node.js";
import { createWorkspaceInventoryReader } from "../../workspace-inventory/module.js";
import type { FindingsBaselineDependencies, FindingsProducer } from "./application/model.js";
import { inputFailure } from "./application/configuration-input.js";
import { FINDINGS_BASELINE_RULES_BY_ID } from "./application/rules.js";
import { checkFindingsBaseline, writeFindingsBaseline, type FindingsBaselineWriteResult } from "./application/use-cases/findings-baseline.js";
import { FilesystemFindingsBaselineStore } from "./adapters/outbound/filesystem/filesystem-findings-baseline-store.js";
import { CAPABILITY_CONFIG_SCHEMA_VERSION, CAPABILITY_ID } from "./contract/config.js";
import { loadCapabilityConfig, type FindingsBaselineConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";

export { FINDINGS_BASELINE_RULES_BY_ID };
export type { FindingsBaselineWriteResult };

type Environment = Readonly<Record<string, string | undefined>>;

interface FindingsBaselineModuleInput {
  readonly assertSchema: FindingsBaselineConfigurationDependencies["assertSchema"];
  /** Environment of the pinned Oxlint process, supplied by the command host. */
  readonly environment: Environment;
}

/** Runs the consumer's pinned Oxlint through the quality coverage session; its findings are `oxlint/<plugin>/<rule>`. */
function createOxlintFindingsProducer(environment: Environment): FindingsProducer {
  const inventoryReader = createWorkspaceInventoryReader();
  const sourceReader = createSourceTreeReader();
  return {
    async observe({ consumerRoot, policy, signal }) {
      const inventory = await inventoryReader.read(consumerRoot, "pnpm-workspace.yaml", signal);
      const rootPackage = inventory.packages.find(({ manifestPath }) => manifestPath === "package.json");
      if (rootPackage === undefined) { inputFailure("FINDINGS_BASELINE_CONSUMER_INVALID", "The consumer root package is missing from workspace observations.", "findings-baseline-execution"); }
      const tools = await inspectConsumerToolchain({
        consumerRoot, dependencies: rootPackage.dependencies, read: readContainedRegularFile,
        ...(signal === undefined ? {} : { signal })
      });
      const files = await sourceReader.read(consumerRoot, policy.oxlint.roots, signal);
      const session = createOxlintSession({
        consumerRoot, ...tools, nodeExecutable: process.execPath,
        environment: { ...environment, OXLINT_TSGOLINT_PATH: tools.typedEntrypoint },
        configPath: policy.oxlint.configPath, sourceRoots: files.map(({ path }) => path), projects: []
      }, createManagedProcessExecutor());
      const findings = await session.findings(new Set(policy.oxlint.measuredRules), signal);
      return findings.map(({ path, rule, count, max }) => ({ path, rule: `oxlint/${rule}`, count, ...(max === undefined ? {} : { max }) }));
    }
  };
}

function dependenciesFor(input: FindingsBaselineModuleInput): FindingsBaselineDependencies {
  return Object.freeze({
    producer: createOxlintFindingsProducer(input.environment),
    store: new FilesystemFindingsBaselineStore({ read: readContainedRegularFile, pathTraversesSymbolicLink })
  });
}

const configuration = (input: FindingsBaselineModuleInput) => ({ readYaml: loadStrictYamlFile, assertSchema: input.assertSchema });

export function createFindingsBaselineCapability(input: FindingsBaselineModuleInput): CapabilityDefinition {
  const dependencies = dependenciesFor(input);
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(configuration(input), invocation.consumerRoot, invocation.configPath, invocation.signal);
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: await checkFindingsBaseline(
            { consumerRoot: invocation.consumerRoot, policy, ...(invocation.signal === undefined ? {} : { signal: invocation.signal }) },
            dependencies
          )
        });
      } catch (error) {
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "findings-baseline-execution"
        });
      }
    }
  });
}

/** The `baseline check`, `baseline init` and `baseline prune` commands. */
export function createFindingsBaselineCommands(input: FindingsBaselineModuleInput) {
  const dependencies = dependenciesFor(input);
  const capability = createFindingsBaselineCapability(input);
  return {
    check: (command: CapabilityInvocation) => capability.run(command),
    async write(command: CapabilityInvocation & { readonly action: "init" | "prune" }): Promise<FindingsBaselineWriteResult> {
      const policy = await loadCapabilityConfig(configuration(input), command.consumerRoot, command.configPath, command.signal);
      return writeFindingsBaseline(
        { consumerRoot: command.consumerRoot, policy, action: command.action, ...(command.signal === undefined ? {} : { signal: command.signal }) },
        dependencies
      );
    }
  };
}

/** Selects the schema assertion once; the command host supplies the environment per invocation. */
export function createFindingsBaselineCommandsFactory(assertSchema: FindingsBaselineConfigurationDependencies["assertSchema"]) {
  return (environment: Environment) => createFindingsBaselineCommands({ assertSchema, environment });
}
