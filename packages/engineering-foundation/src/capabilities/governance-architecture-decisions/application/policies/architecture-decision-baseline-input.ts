import { CapabilityInputError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import type { ArchitectureDecisionBaselineExpectedState, ArchitectureDecisionBaselineReadResult } from "../ports/architecture-decision-baseline-repository.js";

const WRITE_PHASE = "architecture-decision-baseline-write";

export function rejectBaselineWrite(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: WRITE_PHASE,
    retryable: false
  });
}

export function assertExpectedBaselineState(
  current: ArchitectureDecisionBaselineReadResult,
  expected: ArchitectureDecisionBaselineExpectedState
): void {
  if (current.kind === "unsafe") {
    rejectBaselineWrite(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_UNSAFE_TARGET",
      `Accepted-decision baseline target is unsafe: ${current.message}`
    );
  }
  if (current.kind === "invalid") {
    rejectBaselineWrite(
      "ARCHITECTURE_DECISION_BASELINE_WRITE_INVALID_TARGET",
      `Accepted-decision baseline target is invalid: ${current.message}`
    );
  }
  if (expected.kind === "missing" && current.kind === "missing") {
    return;
  }
  if (
    expected.kind === "valid" &&
    current.kind === "valid" &&
    current.revision === expected.revision
  ) {
    return;
  }
  rejectBaselineWrite(
    "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT",
    "Accepted-decision baseline changed, appeared, or became unavailable during promotion. Re-run promotion from the current repository state."
  );
}

export function assertBaselineObservationActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}

export function isBaselineInputFailure(error: unknown): boolean {
  return error instanceof CapabilityInputError;
}
