export type DocumentAuthoringErrorCode = "CONSUMER_INVALID";

export class DocumentAuthoringError extends Error {
  readonly code: DocumentAuthoringErrorCode;

  constructor(code: DocumentAuthoringErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentAuthoringError";
    this.code = code;
  }
}
