export type DocumentAuthoringSchemaId =
  | "document-authoring-profile/v1" | "document-authoring-profile/v2"
  | "document-authoring-profile/v3" | "document-command-envelope/v1"
  | "document-command-envelope/v2" | "document-intent/v1"
  | "document-parent-materialization/v2" | "document-plan/v1"
  | "document-authoring/document-plan/v1" | "document-authoring/document-plan/v2"
  | "document-authoring/document-file-transaction-envelope/v1"
  | "document-authoring/document-directory-transaction-envelope/v1"
  | "document-plan/v2" | "document-receipt/v1" | "document-receipt/v2"
  | "foundation-transaction-envelope/v3" | "foundation-transaction-envelope/v4";

/** Validation of closed persisted/wire generations; no filesystem or provider DTOs. */
export interface DocumentSchemaValidator {
  assertSchema(schemaId: DocumentAuthoringSchemaId, input: unknown, phase: string): Promise<void>;
}
