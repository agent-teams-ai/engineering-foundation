import { CapabilityInputError, FoundationError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";

export function rejectEffectiveInstructionInput(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-agent-workflow-effective-instructions",
    retryable: false
  });
}

export function rejectWorkflowEvidence(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-agent-workflow-evidence",
    retryable: false
  });
}

export function assertWorkflowObservationActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}

export function isWorkflowInputFailure(error: unknown): boolean {
  return error instanceof CapabilityInputError;
}

export function rejectChangedWorkflowInput(message: string): never {
  throw new FoundationError("CONSUMER_INVALID", message);
}

export function rejectWorkflowExecutor(): never {
  throw new FoundationError(
    "PROCESS_FAILED",
    "Unable to resolve a shell-free pnpm entrypoint on Windows."
  );
}
