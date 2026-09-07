import { FoundationError } from "../../features/validation-reporting/api.js";

export function operationLockAcquisitionFailure(cause: unknown, providerMessage?: string): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    providerMessage ?? "Another Foundation operation is active or its shared mutation lock is not safely recoverable.",
    { cause }
  );
}

export function operationLockReleaseFailure(cause: unknown): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Foundation could not release the shared mutation lock without violating ownership.",
    { cause }
  );
}
