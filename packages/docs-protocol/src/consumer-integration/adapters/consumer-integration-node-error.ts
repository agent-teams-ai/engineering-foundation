export class ConsumerIntegrationNodeError extends Error {
  readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConsumerIntegrationNodeError";
    this.code = code;
  }
}
