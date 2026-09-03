import type { DocumentPlanningProfileSnapshot } from "../model/document-planning.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

export function assertV2PlanningProfile(
  profile: DocumentPlanningProfileSnapshot,
  requestedPolicy: "create-missing-real-directories" | undefined
): void {
  if ((requestedPolicy !== undefined) !== (profile.schemaVersion === 2 || profile.schemaVersion === 3)) {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_INPUT_INVALID",
      "Profile v2/v3 and create-missing-real-directories must select Document Plan v2 together."
    );
  }
}
