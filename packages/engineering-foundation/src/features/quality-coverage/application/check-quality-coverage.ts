import {
  capabilityFailureReport,
  capabilityReport,
  assertNotCancelled,
  type CapabilityInvocation,
  type CapabilityReport,
} from "../../validation-reporting/api.js";
import {
  evaluateSelectedCoverage,
  evaluateStaticCoverage,
  evaluateTypeContext,
} from "./evaluate-coverage.js";
import type { QualityCoverageReader, QualityToolProvider } from "./model.js";
import { qualitySourceLanguage } from "./source-coverage.js";
import { QUALITY_COVERAGE_ID, qualityDiagnostic } from "./rules.js";

/** Static validation has no process port and cannot accidentally execute a tool. */
export async function checkStaticQualityCoverage(
  input: CapabilityInvocation,
  reader: QualityCoverageReader,
): Promise<CapabilityReport> {
  let schemaVersion = 5;
  try {
    assertNotCancelled(input.signal);
    const observed = await reader.read(
      input.consumerRoot,
      input.configPath,
      input.signal,
      (version) => {
        schemaVersion = version;
      },
    );
    const { observation } = observed;
    assertNotCancelled(input.signal);
    const diagnostics = evaluateStaticCoverage(observation);
    await observed.verify(input.signal);
    observed.remainingMs();
    return report(diagnostics, schemaVersion);
  } catch (error) {
    return failure(error, schemaVersion);
  }
}

/** Selection is always observed; only full mode invokes typed lint. */
export async function checkQualityCoverage(
  input: CapabilityInvocation & { readonly scopeOnly: boolean },
  reader: QualityCoverageReader,
  tools: QualityToolProvider,
): Promise<CapabilityReport> {
  let schemaVersion = 5;
  try {
    assertNotCancelled(input.signal);
    const observed = await reader.read(
      input.consumerRoot,
      input.configPath,
      input.signal,
      (version) => {
        schemaVersion = version;
      },
    );
    const { observation } = observed;
    const diagnostics = [...evaluateStaticCoverage(observation)];
    if (diagnostics.length > 0) {
      return report(diagnostics, schemaVersion);
    }
    assertNotCancelled(input.signal);
    const production = observation.sources
      .map(({ path }) => path)
      .filter(
        (path) =>
          qualitySourceLanguage(path) === "typescript" ||
          qualitySourceLanguage(path) === "javascript",
      );
    const session = await tools.prepare(observed, production, input.signal);
    await observed.verify(input.signal);
    observed.remainingMs();
    const selected = await session.select(input.signal);
    diagnostics.push(...evaluateSelectedCoverage(production, selected, observation.testPaths));
    assertNotCancelled(input.signal);
    const typed = production.filter((path) => qualitySourceLanguage(path) === "typescript");
    diagnostics.push(...evaluateTypeContext(typed, await session.typeContext(input.signal)));
    if (diagnostics.length === 0 && !input.scopeOnly) {
      diagnostics.push(
        ...(await session.explicitUnknown(input.signal)).map(({ path, start, end, sha256 }) =>
          qualityDiagnostic(
            "explicit-unknown",
            path,
            `${path}:${start}-${end}`,
            "Exact bridge admission with rationale and rejecting test",
            sha256,
          ),
        ),
      );
    }
    if (diagnostics.length === 0 && !input.scopeOnly) {
      const lint = await session.lint(input.signal);
      const selectedPaths = new Set(selected);
      if (
        lint.files !== selectedPaths.size ||
        lint.diagnostics.some(({ location }) => !selectedPaths.has(location.path))
      ) {
        throw new Error("Typed execution evidence differs from the qualified selection.");
      }
      diagnostics.push(...lint.diagnostics);
    }
    assertNotCancelled(input.signal);
    await observed.verify(input.signal);
    observed.remainingMs();
    return report(diagnostics, schemaVersion);
  } catch (error) {
    return failure(error, schemaVersion);
  }
}

function report(
  diagnostics: NonNullable<Parameters<typeof capabilityReport>[0]["diagnostics"]>,
  schemaVersion: number,
): CapabilityReport {
  return capabilityReport({
    capabilityId: QUALITY_COVERAGE_ID,
    capabilityConfigSchemaVersion: schemaVersion,
    diagnostics,
  });
}

function failure(error: unknown, schemaVersion: number): CapabilityReport {
  return capabilityFailureReport({
    capabilityId: QUALITY_COVERAGE_ID,
    capabilityConfigSchemaVersion: schemaVersion,
    error,
    phase: "quality-coverage",
  });
}
