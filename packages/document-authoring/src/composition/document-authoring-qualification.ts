import type {
  DocumentAuthoringCrashQualificationResult,
  DocumentTransactionEnvelope,
  RunDocumentAuthoringCrashQualificationRequest
} from "../document-authoring/testing/api.js";
import { createDocumentAuthoringCrashQualification, assertDocumentTransactionEnvelope as validateEnvelope } from "../document-authoring/testing/api.js";
import { createNodeDocumentAuthority, documentSchemaValidator } from "../document-authoring/module.js";
import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../documentation-observation/module.js";

const runCrashQualification = createDocumentAuthoringCrashQualification(createNodeDocumentAuthority({
  repository: new FilesystemMarkdownRepository(),
  readFile: readContainedRegularFile,
  syntax: readMarkdownSyntax
}));

export function runDocumentAuthoringCrashQualification(
  request: RunDocumentAuthoringCrashQualificationRequest
): Promise<DocumentAuthoringCrashQualificationResult> {
  return runCrashQualification(request);
}

export function assertDocumentTransactionEnvelope(value: unknown): Promise<DocumentTransactionEnvelope> {
  return validateEnvelope(documentSchemaValidator, value);
}
