import type { CapabilityDefinition, CapabilityInvocation } from "../../validation-reporting/api.js";
import type { QualityCoverageReader, QualityToolProvider } from "./model.js";
import { checkQualityCoverage, checkStaticQualityCoverage } from "./check-quality-coverage.js";
import { QUALITY_COVERAGE_ID } from "./rules.js";

export function createQualityCoverageCapability(reader: QualityCoverageReader): CapabilityDefinition {
  return {
    id: QUALITY_COVERAGE_ID, configSchemaVersion: 1,
    run: (invocation) => checkStaticQualityCoverage(invocation, reader)
  };
}

export function createQualityCoverageCommand(reader: QualityCoverageReader, tools: QualityToolProvider) {
  return (input: CapabilityInvocation & { readonly scopeOnly: boolean }) => checkQualityCoverage(input, reader, tools);
}
