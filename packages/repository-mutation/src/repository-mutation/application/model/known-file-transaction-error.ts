export class KnownFileTransactionError extends Error {
  readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KnownFileTransactionError";
    this.code = code;
  }
}

export class KnownFileTransactionPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnownFileTransactionPlanError";
  }
}
