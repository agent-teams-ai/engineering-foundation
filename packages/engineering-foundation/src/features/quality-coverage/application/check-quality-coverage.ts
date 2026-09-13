import {
  capabilityFailureReport, capabilityReport, assertNotCancelled,
  type CapabilityInvocation, type CapabilityReport
} from "../../validation-reporting/api.js";
import { evaluateSelectedCoverage, evaluateStaticCoverage, evaluateTypeContext } from "./evaluate-coverage.js";
import type { QualityCoverageReader, QualityToolProvider } from "./model.js";
import { qualitySourceLanguage } from "./source-coverage.js";
import { QUALITY_COVERAGE_ID } from "./rules.js";

/** Static validation has no process port and cannot accidentally execute a tool. */
export async function checkStaticQualityCoverage(input: CapabilityInvocation, reader: QualityCoverageReader): Promise<CapabilityReport> {
  try {
    assertNotCancelled(input.signal);
    const observation = await reader.read(input.consumerRoot, input.configPath, input.signal);
    assertNotCancelled(input.signal);
    return report(evaluateStaticCoverage(observation));
  } catch (error) {
    return failure(error);
  }
}

/** Selection is always observed; only full mode invokes typed lint. */
export async function checkQualityCoverage(
  input: CapabilityInvocation & { readonly scopeOnly: boolean },
  reader: QualityCoverageReader,
  tools: QualityToolProvider
): Promise<CapabilityReport> {
  try {
    assertNotCancelled(input.signal);
    const observation = await reader.read(input.consumerRoot, input.configPath, input.signal);
    const diagnostics = [...evaluateStaticCoverage(observation)];
    if (diagnostics.length > 0) { return report(diagnostics); }
    assertNotCancelled(input.signal);
    const session = await tools.prepare(input.consumerRoot, input.configPath, input.signal);
    const production = observation.sources.map(({ path }) => path)
      .filter((path) => qualitySourceLanguage(path) === "typescript" || qualitySourceLanguage(path) === "javascript");
    const selected = await session.select(input.signal);
    diagnostics.push(...evaluateSelectedCoverage(production, selected, observation.testPaths));
    assertNotCancelled(input.signal);
    const typed = production.filter((path) => qualitySourceLanguage(path) === "typescript");
    diagnostics.push(...evaluateTypeContext(typed, await session.typeContext(input.signal)));
    if (diagnostics.length === 0 && !input.scopeOnly) {
      const lint = await session.lint(input.signal);
      const selectedPaths = new Set(selected);
      if (lint.files !== selectedPaths.size || lint.diagnostics.some(({ location }) => !selectedPaths.has(location.path))) {
        throw new Error("Typed execution evidence differs from the qualified selection.");
      }
      diagnostics.push(...lint.diagnostics);
    }
    assertNotCancelled(input.signal);
    return report(diagnostics);
  } catch (error) {
    return failure(error);
  }
}

function report(diagnostics: NonNullable<Parameters<typeof capabilityReport>[0]["diagnostics"]>): CapabilityReport {
  return capabilityReport({ capabilityId: QUALITY_COVERAGE_ID, capabilityConfigSchemaVersion: 1, diagnostics });
}

function failure(error: unknown): CapabilityReport {
  return capabilityFailureReport({ capabilityId: QUALITY_COVERAGE_ID, capabilityConfigSchemaVersion: 1, error, phase: "quality-coverage" });
}
