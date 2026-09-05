import { CapabilityInputError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";

export function rejectBufQualificationInput(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-qualification-evidence",
    retryable: false
  });
}

export function assertBufQualificationActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}
