import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemSourceTreeReader } from "../../source-inventory/adapters/outbound/filesystem/filesystem-source-tree-reader.js";
import { OxcSuppressionScanner } from "./adapters/outbound/oxc/oxc-suppression-scanner.js";
import { SystemCalendarClock } from "./adapters/outbound/time/system-clock.js";
import { SUPPRESSION_GOVERNANCE_RULES_BY_ID } from "./application/rules.js";
import { analyzeSuppressionGovernance } from "./application/use-cases/analyze-suppression-governance.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { SUPPRESSION_GOVERNANCE_RULES_BY_ID };

export function createSuppressionGovernanceCapability(): CapabilityDefinition {
  const dependencies = Object.freeze({
    clock: new SystemCalendarClock(),
    scanner: new OxcSuppressionScanner(),
    sourceReader: new FilesystemSourceTreeReader()
  });
  return Object.freeze({
    id: CAPABILITY_ID,
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    async run(invocation: CapabilityInvocation) {
      try {
        const policy = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          diagnostics: await analyzeSuppressionGovernance(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            dependencies
          )
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityId: CAPABILITY_ID,
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            outcome:
              error.problem.code === "EXECUTION_CANCELLED"
                ? "cancelled"
                : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Suppression governance capability execution failed.",
            phase: "suppression-governance-execution",
            retryable: false
          }
        });
      }
    }
  });
}
