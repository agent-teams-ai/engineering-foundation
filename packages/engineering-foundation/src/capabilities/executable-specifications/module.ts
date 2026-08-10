import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemExecutableSpecificationInspector } from "./adapters/outbound/filesystem/filesystem-executable-specification-inspector.js";
import { analyzeExecutableSpecifications } from "./application/use-cases/analyze-executable-specifications.js";
import {
  EXECUTABLE_SPECIFICATION_RULES,
  EXECUTABLE_SPECIFICATION_RULES_BY_ID
} from "./application/rules.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { FilesystemExecutableSpecificationInspector } from "./adapters/outbound/filesystem/filesystem-executable-specification-inspector.js";
export type {
  ConsumerGateBinding,
  ExecutableSpecification,
  ExecutableSpecificationCatalog,
  ExecutableSpecificationDocument,
  ExecutableSpecificationObservation,
  GeneratedTypeBinding,
  NoStateModel,
  ObservedGateBinding,
  XstateStateModel
} from "./application/model/executable-specification.js";
export { evaluateExecutableSpecifications } from "./application/policies/evaluate-executable-specifications.js";
export type { ExecutableSpecificationInspector } from "./application/ports/executable-specification-inspector.js";
export {
  EXECUTABLE_SPECIFICATION_RULES,
  EXECUTABLE_SPECIFICATION_RULES_BY_ID
};
export { analyzeExecutableSpecifications } from "./application/use-cases/analyze-executable-specifications.js";

export function createExecutableSpecificationsCapability(): CapabilityDefinition {
  const inspector = new FilesystemExecutableSpecificationInspector();
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const catalog = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: await analyzeExecutableSpecifications(
            {
              consumerRoot: invocation.consumerRoot,
              catalog,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            inspector
          )
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityId: CAPABILITY_ID,
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            outcome: error.problem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Executable specifications capability execution failed.",
            phase: "executable-specification-execution",
            retryable: false
          }
        });
      }
    }
  });
}
