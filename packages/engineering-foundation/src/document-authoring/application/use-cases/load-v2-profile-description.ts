import type { DocumentAuthoringProfileDescriptionV2 } from "../model/document-authoring-profile-description.js";
import type { DocumentPlanningProfileSnapshot } from "../model/document-planning.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

export interface DocumentProfileDescriptionReader {
  describe(request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentAuthoringProfileDescriptionV2>;
}

export async function loadV2ProfileDescription(
  reader: DocumentProfileDescriptionReader | undefined,
  profile: DocumentPlanningProfileSnapshot,
  request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }
): Promise<DocumentAuthoringProfileDescriptionV2 | undefined> {
  if (profile.schemaVersion !== 2 && profile.schemaVersion !== 3) {
    return undefined;
  }
  const description = await reader?.describe(request);
  if (description === undefined) {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
      "Document Plan v2 requires a stable profile semantic description."
    );
  }
  return description;
}
