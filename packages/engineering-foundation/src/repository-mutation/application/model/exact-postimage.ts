export interface ExactFilePostimage {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mode: number;
  readonly size: number;
}

export type ExactFilePostimageState = "absent" | "conflict" | "exact";

export type AbsentFilePublicationOutcome = "already-satisfied" | "published";

export type AbsentFilePublicationErrorCode =
  | "CLEANUP_FAILED"
  | "CONFLICT"
  | "INVALID_ERROR"
  | "INVALID_POSTIMAGE"
  | "PUBLICATION_INVALID"
  | "PUBLICATION_INCOMPLETE"
  | "PUBLICATION_UNSUPPORTED"
  | "TEMPORARY_EXISTS"
  | "TEMPORARY_REPLACED"
  | "VERIFICATION_FAILED";

export class AbsentFilePublicationError extends Error {
  readonly code: AbsentFilePublicationErrorCode;
  readonly cleanupError: unknown;

  constructor(
    code: AbsentFilePublicationErrorCode,
    message: string,
    options?: ErrorOptions & { readonly cleanupError?: unknown }
  ) {
    super(message, options);
    this.name = "AbsentFilePublicationError";
    this.code = code;
    this.cleanupError = options?.cleanupError;
  }
}
