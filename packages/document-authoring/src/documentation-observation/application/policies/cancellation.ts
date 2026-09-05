import { CapabilityInputError } from "../model/input-problem.js";

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CapabilityInputError({
      code: "EXECUTION_CANCELLED",
      message: "Document authoring was cancelled.",
      phase: "execution",
      retryable: false
    });
  }
}
