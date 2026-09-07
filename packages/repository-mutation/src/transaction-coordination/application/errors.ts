export type RepositoryMutationErrorCode =
  | "MUTATION_CLAIM_INVALID"
  | "MUTATION_LEASE_INVALID"
  | "MUTATION_STATE_INVALID";

export class RepositoryMutationError extends Error {
  readonly code: RepositoryMutationErrorCode;

  constructor(code: RepositoryMutationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryMutationError";
    this.code = code;
  }
}
