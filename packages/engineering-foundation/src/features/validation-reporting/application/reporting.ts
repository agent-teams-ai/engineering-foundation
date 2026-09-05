import type {
  CapabilityReport,
  DiagnosticSummary,
  FoundationCheckCoverage,
  FoundationCheckReport,
  FoundationDiagnostic,
  FoundationOutcome,
  FoundationProblem
} from "./model.js";
import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import { FOUNDATION_REPORT_SCHEMA_VERSION } from "./model.js";
import {
  classifyUnexpectedFailure,
  isProcessCancellationFailure
} from "./unexpected-failure.js";

const OUTCOME_PRECEDENCE: Readonly<Record<FoundationOutcome, number>> = {
  passed: 0,
  violations: 1,
  "invalid-input": 2,
  failed: 3,
  cancelled: 4
};

export class CapabilityInputError extends Error {
  readonly problem: FoundationProblem;

  constructor(problem: FoundationProblem, options?: ErrorOptions) {
    super(problem.message, options);
    this.name = "CapabilityInputError";
    this.problem = problem;
  }
}

export function readCapabilityInputProblem(error: unknown): FoundationProblem | undefined {
  try {
    if (!(error instanceof CapabilityInputError)) {
      return undefined;
    }
    const problem = error.problem as unknown as Record<string, unknown>;
    if (
      typeof problem.code !== "string" ||
      problem.code.length === 0 ||
      typeof problem.message !== "string" ||
      problem.message.length === 0 ||
      problem.message.length > 1000 ||
      typeof problem.phase !== "string" ||
      problem.phase.length === 0 ||
      typeof problem.retryable !== "boolean"
    ) {
      return undefined;
    }
    return {
      code: problem.code,
      message: problem.message,
      phase: problem.phase,
      retryable: problem.retryable
    };
  } catch {
    return undefined;
  }
}

export function readCancellationProblem(
  error: unknown,
  phase: string
): FoundationProblem | undefined {
  return isProcessCancellationFailure(error)
    ? {
        code: "EXECUTION_CANCELLED",
        message: "Capability execution was cancelled.",
        phase,
        retryable: false
      }
    : undefined;
}

export interface CapabilityInvocation {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}

export interface CapabilityDefinition {
  readonly id: string;
  readonly configSchemaVersion: number;
  readonly run: (invocation: CapabilityInvocation) => Promise<CapabilityReport>;
}

function emptySummary(): DiagnosticSummary {
  return { errors: 0, warnings: 0, infos: 0 };
}

function summarizeDiagnostics(
  diagnostics: readonly FoundationDiagnostic[]
): DiagnosticSummary {
  return diagnostics.reduce<DiagnosticSummary>(
    (summary, diagnostic) => ({
      errors: summary.errors + (diagnostic.severity === "error" ? 1 : 0),
      warnings: summary.warnings + (diagnostic.severity === "warning" ? 1 : 0),
      infos: summary.infos + (diagnostic.severity === "info" ? 1 : 0)
    }),
    emptySummary()
  );
}

function sortDiagnostics(
  diagnostics: readonly FoundationDiagnostic[]
): readonly FoundationDiagnostic[] {
  return diagnostics.toSorted((left, right) => {
    const leftStart = left.location.start;
    const rightStart = right.location.start;
    return (
      compareBinaryStrings(left.ruleId, right.ruleId) ||
      compareBinaryStrings(left.subject, right.subject) ||
      compareBinaryStrings(left.location.path, right.location.path) ||
      (leftStart?.line ?? 0) - (rightStart?.line ?? 0) ||
      (leftStart?.column ?? 0) - (rightStart?.column ?? 0)
    );
  });
}

export function capabilityReport(input: {
  readonly capabilityId: string;
  readonly capabilityConfigSchemaVersion: number;
  readonly diagnostics?: readonly FoundationDiagnostic[];
  readonly problem?: FoundationProblem;
  readonly outcome?: FoundationOutcome;
}): CapabilityReport {
  const diagnostics = sortDiagnostics(input.diagnostics ?? []);
  const outcome =
    input.outcome ?? (diagnostics.length === 0 ? "passed" : "violations");
  return {
    capabilityId: input.capabilityId,
    capabilityConfigSchemaVersion: input.capabilityConfigSchemaVersion,
    outcome,
    summary: summarizeDiagnostics(diagnostics),
    diagnostics,
    ...(input.problem === undefined ? {} : { problem: input.problem })
  };
}

export function capabilityFailureReport(input: {
  readonly capabilityId: string;
  readonly capabilityConfigSchemaVersion: number;
  readonly error: unknown;
  readonly phase: string;
}): CapabilityReport {
  const inputProblem = readCapabilityInputProblem(input.error);
  if (inputProblem !== undefined) {
    return capabilityReport({
      capabilityId: input.capabilityId,
      capabilityConfigSchemaVersion: input.capabilityConfigSchemaVersion,
      outcome:
        inputProblem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
      problem: inputProblem
    });
  }
  const cancellationProblem = readCancellationProblem(input.error, input.phase);
  if (cancellationProblem !== undefined) {
    return capabilityReport({
      capabilityId: input.capabilityId,
      capabilityConfigSchemaVersion: input.capabilityConfigSchemaVersion,
      outcome: "cancelled",
      problem: cancellationProblem
    });
  }
  return {
    capabilityId: input.capabilityId,
    capabilityConfigSchemaVersion: input.capabilityConfigSchemaVersion,
    diagnostics: [],
    outcome: "failed",
    problem: classifyUnexpectedFailure(input.error, input.phase),
    summary: emptySummary()
  };
}

function highestOutcome(outcomes: readonly FoundationOutcome[]): FoundationOutcome {
  return outcomes.reduce<FoundationOutcome>(
    (highest, outcome) =>
      OUTCOME_PRECEDENCE[outcome] > OUTCOME_PRECEDENCE[highest]
        ? outcome
        : highest,
    "passed"
  );
}

export function foundationReport(input: {
  readonly foundationVersion: string;
  readonly coverage: FoundationCheckCoverage;
  readonly capabilities?: readonly CapabilityReport[];
  readonly problem?: FoundationProblem;
  readonly outcome?: FoundationOutcome;
}): FoundationCheckReport {
  const capabilities = (input.capabilities ?? []).toSorted((left, right) =>
    compareBinaryStrings(left.capabilityId, right.capabilityId)
  );
  const summary = capabilities.reduce<DiagnosticSummary>(
    (total, report) => ({
      errors: total.errors + report.summary.errors,
      warnings: total.warnings + report.summary.warnings,
      infos: total.infos + report.summary.infos
    }),
    emptySummary()
  );
  return {
    reportSchemaVersion: FOUNDATION_REPORT_SCHEMA_VERSION,
    foundationVersion: input.foundationVersion,
    coverage: input.coverage,
    outcome:
      input.outcome ?? highestOutcome(capabilities.map((report) => report.outcome)),
    summary,
    capabilities,
    ...(input.problem === undefined ? {} : { problem: input.problem })
  };
}

export function exitCodeForOutcome(outcome: FoundationOutcome): number {
  switch (outcome) {
    case "passed":
      return 0;
    case "violations":
      return 1;
    case "invalid-input":
      return 2;
    case "failed":
      return 3;
    case "cancelled":
      return 130;
  }
}
