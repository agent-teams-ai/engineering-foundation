import type {
  DocumentAuthoringCrashQualificationResult,
  DocumentTransactionEnvelope,
  RunDocumentAuthoringCrashQualificationRequest
} from "../document-authoring/testing/api.js";
import { createDocumentAuthoringQualification } from "../document-authoring/testing/api.js";
import { createNodeDocumentAuthority, documentSchemaValidator } from "../document-authoring/module.js";
import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../documentation-observation/module.js";

const qualification = createDocumentAuthoringQualification({
  authority: createNodeDocumentAuthority({
    repository: new FilesystemMarkdownRepository(),
    readFile: readContainedRegularFile,
    syntax: readMarkdownSyntax
  }),
  schema: documentSchemaValidator
});

export function runDocumentAuthoringCrashQualification(
  request: RunDocumentAuthoringCrashQualificationRequest
): Promise<DocumentAuthoringCrashQualificationResult> {
  return qualification.runDocumentAuthoringCrashQualification(request);
}

export function assertDocumentTransactionEnvelope(value: unknown): Promise<DocumentTransactionEnvelope> {
  return qualification.assertDocumentTransactionEnvelope(value);
}
