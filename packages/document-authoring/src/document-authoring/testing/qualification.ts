import type { DocumentAuthorityRecompiler } from "../application/ports/document-authority-recompiler.js";
import type { DocumentSchemaValidator } from "../application/ports/document-schema-validator.js";
import type { DocumentTransactionEnvelope } from "../application/model/document-transaction.js";
import { assertDocumentTransactionEnvelope } from "../application/policies/document-transaction-envelope-policy.js";
import {
  createDocumentAuthoringCrashQualification,
  type DocumentAuthoringCrashQualificationResult,
  type RunDocumentAuthoringCrashQualificationRequest
} from "./crash-qualification.js";

export function createDocumentAuthoringQualification(dependencies: {
  readonly authority: DocumentAuthorityRecompiler;
  readonly schema: DocumentSchemaValidator;
}) {
  const runCrashQualification = createDocumentAuthoringCrashQualification(dependencies.authority);
  return {
    runDocumentAuthoringCrashQualification(
      request: RunDocumentAuthoringCrashQualificationRequest
    ): Promise<DocumentAuthoringCrashQualificationResult> {
      return runCrashQualification(request);
    },
    assertDocumentTransactionEnvelope(value: unknown): Promise<DocumentTransactionEnvelope> {
      return assertDocumentTransactionEnvelope(dependencies.schema, value);
    }
  };
}
