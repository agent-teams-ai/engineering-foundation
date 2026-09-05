import { FoundationError } from "../../errors.js";

export class ProcessCancellationError extends FoundationError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROCESS_FAILED", message, options);
    this.name = "ProcessCancellationError";
  }
}

export class ProcessTimeoutError extends FoundationError {
  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions & { readonly requestDescription?: string }
  ) {
    super(
      "PROCESS_FAILED",
      `${options?.requestDescription ?? "Process"} timed out after ${String(timeoutMs)}ms.`,
      options
    );
    this.name = "ProcessTimeoutError";
  }
}
