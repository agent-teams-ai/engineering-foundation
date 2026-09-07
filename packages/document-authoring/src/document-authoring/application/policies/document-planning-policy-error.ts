export type DocumentPlanningPolicyProblem =
  | "catalog-collision"
  | "catalog-incomplete"
  | "destination-conflict"
  | "destination-not-covered"
  | "duplicate-related"
  | "invalid-artifact-type"
  | "invalid-destination"
  | "invalid-identity"
  | "invalid-intent-json"
  | "invalid-slug"
  | "missing-destination"
  | "missing-slug";

export class DocumentPlanningPolicyError extends Error {
  readonly problem: DocumentPlanningPolicyProblem;

  constructor(problem: DocumentPlanningPolicyProblem, message: string) {
    super(message);
    this.name = "DocumentPlanningPolicyError";
    this.problem = problem;
  }
}
