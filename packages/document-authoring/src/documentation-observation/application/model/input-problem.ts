export interface AuthoringInputProblem {
  readonly code: string;
  readonly message: string;
  readonly phase: string;
  readonly retryable: boolean;
}

/** Stable invalid-input error retained by the authoring contract projections. */
export class CapabilityInputError extends Error {
  readonly problem: AuthoringInputProblem;

  constructor(problem: AuthoringInputProblem, options?: ErrorOptions) {
    super(problem.message, options);
    this.name = "CapabilityInputError";
    this.problem = problem;
  }
}
