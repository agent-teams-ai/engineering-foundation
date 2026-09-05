import { createDocumentAuthoringCrashQualification, assertDocumentTransactionEnvelope as validateEnvelope } from "../document-authoring/testing/api.js";
import { createNodeDocumentAuthority, documentSchemaValidator } from "../document-authoring/module.js";
import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../documentation-observation/module.js";
export const runDocumentAuthoringCrashQualification = createDocumentAuthoringCrashQualification(createNodeDocumentAuthority({ repository: new FilesystemMarkdownRepository(), readFile: readContainedRegularFile, syntax: readMarkdownSyntax }));


export const assertDocumentTransactionEnvelope = validateEnvelope.bind(undefined, documentSchemaValidator);
