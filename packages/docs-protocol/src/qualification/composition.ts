import { planDocumentationDocumentV2 } from "@agent-teams/document-authoring";
import { readQualificationProfile } from "../features/portable-documentation/qualification.js";
import { createProtocol } from "../features/docs-command/qualification.js";
import { crashAtDurablePublishing } from "../features/qualification/adapters/crash-driver.js";
import { qualificationWorkspace } from "../features/qualification/adapters/run-qualification.js";
import { createInterruptAndRecover } from "../features/qualification/application/recovery.js";
import { createQualificationRunner } from "../features/qualification/application/run-qualification.js";

export const interruptAndRecover = createInterruptAndRecover({
  readProfile: readQualificationProfile,
  planDocument: planDocumentationDocumentV2,
  crashAtDurablePublishing
});
export const runDocsProtocolQualification = createQualificationRunner({
  workspace: qualificationWorkspace,
  createProtocol,
  interruptAndRecover
});
