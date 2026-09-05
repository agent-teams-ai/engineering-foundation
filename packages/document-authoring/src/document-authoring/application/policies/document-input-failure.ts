import {
  assertNotCancelled,
  CapabilityInputError
} from "../../../documentation-observation/api.js";

export interface DocumentInputFailure extends Error {
  readonly problem: {
    readonly code: string;
    readonly message: string;
    readonly phase: string;
    readonly retryable: boolean;
  };
}

/** Preserve the selected observation provider's error identity at the feature boundary. */
export function isDocumentInputFailure(error: unknown): error is DocumentInputFailure {
  return error instanceof CapabilityInputError;
}

export function createDocumentInputFailure(
  code: "YAML_INVALID" | "YAML_FEATURE_PROHIBITED" | "SCHEMA_INVALID",
  message: string,
  phase: string
): DocumentInputFailure {
  return new CapabilityInputError({ code, message, phase, retryable: false });
}

export function assertDocumentAuthoringActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}
