export interface ExactFilePostimage {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mode: number;
  readonly size: number;
}

export type ExactFilePostimageState = "absent" | "conflict" | "exact";

export type AbsentFilePublicationOutcome = "already-satisfied" | "published";

export type AbsentFilePublicationErrorCode =
  | "CONFLICT"
  | "INVALID_ERROR"
  | "INVALID_POSTIMAGE"
  | "PUBLICATION_INCOMPLETE"
  | "PUBLICATION_UNSUPPORTED"
  | "TEMPORARY_EXISTS"
  | "TEMPORARY_REPLACED"
  | "VERIFICATION_FAILED";

export class AbsentFilePublicationError extends Error {
  readonly code: AbsentFilePublicationErrorCode;

  constructor(
    code: AbsentFilePublicationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AbsentFilePublicationError";
    this.code = code;
  }
}
