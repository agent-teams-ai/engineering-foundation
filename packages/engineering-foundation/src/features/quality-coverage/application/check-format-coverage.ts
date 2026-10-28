import {
  assertNotCancelled,
  capabilityFailureReport,
  capabilityReport,
  CapabilityInputError,
  type CapabilityInvocation,
  type CapabilityReport,
  type RuleExplanation,
  type CapabilityDefinition,
} from "../../validation-reporting/api.js";
import { classifyFormatCoverage } from "./format-coverage.js";
import type { FormatCoveragePorts } from "./format-coverage-ports.js";

export const FORMAT_COVERAGE_ID = "quality.format-coverage";
export const FORMAT_COVERAGE_RULES_BY_ID: ReadonlyMap<string, RuleExplanation> = new Map([
  [
    `${FORMAT_COVERAGE_ID}.execution-mode`,
    {
      id: `${FORMAT_COVERAGE_ID}.execution-mode`,
      rationale: "Static scope and actual execution are separate evidence.",
      remediation: "Use the explicit full command for execution qualification.",
      documentation: "docs/reference/quality-format-coverage.md",
    },
  ],
]);

export function rejectFormatCoverage(message: string): never {
  throw new CapabilityInputError({
    code: "FORMAT_COVERAGE_INVALID",
    message: message.slice(0, 1000),
    phase: "format-coverage",
    retryable: false,
  });
}

/** Static mode checks scope/admission; only explicit full mode executes tools. */
export async function checkFormatCoverage(
  input: CapabilityInvocation & { readonly scopeOnly: boolean },
  ports: FormatCoveragePorts,
): Promise<CapabilityReport> {
  const started = ports.nowMs();
  try {
    assertNotCancelled(input.signal);
    if (!input.scopeOnly && (ports.execution === undefined || ports.execution.qualityGateActive)) {
      rejectFormatCoverage("Full formatting requires its top-level execution owner.");
    }
    const observed = await ports.read(input);
    const remaining = () => {
      assertNotCancelled(input.signal);
      const value = Math.floor(started + observed.budgetMs - ports.nowMs());
      if (value <= 0) {
        rejectFormatCoverage("Original formatting budget was exhausted.");
      }
      return value;
    };
    remaining();
    const classified = classifyFormatCoverage(observed.paths, observed.selection);
    if (classified.problems.length > 0) {
      rejectFormatCoverage(classified.problems.slice(0, 8).join(" "));
    }
    const formatter = await ports.prepareFormatter(input.consumerRoot, input.signal);
    remaining();
    if (!input.scopeOnly) {
      await ports.verify(input, observed);
      remaining();
      if (classified.formatFiles.length > 0) {
        await formatter(
          classified.formatFiles,
          input.signal ?? new AbortController().signal,
          remaining(),
        );
      }
      remaining();
      if (observed.authorities.length > 0) {
        await ports.verify(input, observed);
        remaining();
        if (ports.execution === undefined) {
          rejectFormatCoverage("Missing authority execution owner.");
        }
        await ports.execution.runAuthorities(input, observed, remaining());
      }
    }
    await ports.verify(input, observed);
    remaining();
    return capabilityReport({
      capabilityId: FORMAT_COVERAGE_ID,
      capabilityConfigSchemaVersion: 1,
      outcome: "passed",
      diagnostics: [
        {
          ruleId: `${FORMAT_COVERAGE_ID}.execution-mode`,
          severity: "info",
          subject: input.scopeOnly ? "static-scope" : "full-execution",
          message: input.scopeOnly
            ? "Static classification and admission only; formatter and authority execution are absent."
            : "Literal selection and all required authorities completed with unchanged source bytes.",
          location: { path: input.configPath },
          relatedLocations: [],
          evidence: [{ kind: "mode", value: input.scopeOnly ? "static-only" : "full" }],
          remediation: "Full execution remains required for consumer qualification.",
          requiresArchitectureReview: false,
        },
      ],
    });
  } catch (error) {
    return capabilityFailureReport({
      capabilityId: FORMAT_COVERAGE_ID,
      capabilityConfigSchemaVersion: 1,
      error,
      phase: "format-coverage",
    });
  }
}

export function createFormatCoverageCapability(ports: FormatCoveragePorts): CapabilityDefinition {
  return {
    id: FORMAT_COVERAGE_ID,
    configSchemaVersion: 1,
    run: (input) => checkFormatCoverage({ ...input, scopeOnly: true }, ports),
  };
}
