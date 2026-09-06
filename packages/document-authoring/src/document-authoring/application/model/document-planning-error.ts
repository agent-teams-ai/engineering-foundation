export type DocumentPlanningErrorCode =
  | "DOCUMENT_PLANNING_AUTHORITY_CHANGED"
  | "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE"
  | "DOCUMENT_PLANNING_CATALOG_PARTIAL"
  | "DOCUMENT_PLANNING_CONFLICT"
  | "DOCUMENT_PLANNING_INPUT_INVALID"
  | "DOCUMENT_PLANNING_OUTPUT_INVALID"
  | "DOCUMENT_PLANNING_PARENT_UNAVAILABLE";

export class DocumentPlanningError extends Error {
  readonly code: DocumentPlanningErrorCode;

  constructor(
    code: DocumentPlanningErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DocumentPlanningError";
    this.code = code;
  }
}
