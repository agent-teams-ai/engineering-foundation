import {
  capabilityFailureReport,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../features/validation-reporting/api.js";
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
        return capabilityFailureReport({
          capabilityId: CAPABILITY_ID,
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          error,
          phase: "suppression-governance-execution"
        });
      }
    }
  });
}
