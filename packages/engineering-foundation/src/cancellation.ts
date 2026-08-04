import { CapabilityInputError } from "./capability-runtime.js";

/**
 * Throws the stable cancellation outcome without coupling callers to a
 * configuration or filesystem adapter.
 */
export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CapabilityInputError({
      code: "EXECUTION_CANCELLED",
      message: "Foundation check was cancelled.",
      phase: "execution",
      retryable: false
    });
  }
}
