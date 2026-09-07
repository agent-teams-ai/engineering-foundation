import type {
  DocumentArtifactType,
  DocumentIntent
} from "../model/document-planning.js";
import { DocumentPlanningError } from "../model/document-planning-error.js";

export function assertArtifactOwnerAllowed(
  artifact: DocumentArtifactType,
  intent: DocumentIntent
): void {
  if (
    artifact.allowedOwnerIds !== undefined &&
    !artifact.allowedOwnerIds.includes(intent.owner)
  ) {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_INPUT_INVALID",
      `Document owner ${intent.owner} is not allowed for artifact type ${artifact.type}.`
    );
  }
}
