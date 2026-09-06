export class DocumentTransactionUseCaseError extends Error {
  public constructor(
    readonly code:
      | "DOCUMENT_TRANSACTION_COORDINATION_FAILED"
      | "DOCUMENT_TRANSACTION_EVIDENCE_UNAVAILABLE"
      | "DOCUMENT_TRANSACTION_INCONSISTENT",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DocumentTransactionUseCaseError";
  }
}
