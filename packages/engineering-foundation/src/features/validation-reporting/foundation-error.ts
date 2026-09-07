export type FoundationErrorCode =
  | "CONFIG_INVALID"
  | "CONSUMER_INVALID"
  | "LOCAL_STATE_INVALID"
  | "PACKAGE_INVALID"
  | "PROCESS_FAILED"
  | "REGISTRY_MODE_REQUIRED";

export class FoundationError extends Error {
  readonly code: FoundationErrorCode;

  constructor(code: FoundationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FoundationError";
    this.code = code;
  }
}
