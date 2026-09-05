import type {
  DocumentAuthoringProfileDescriptionV2,
  DocumentAuthoringProfileDescriptionV3
} from "../model/document-authoring-profile-description.js";
import type { DocumentPlanningProfileSnapshot } from "../model/document-planning.js";
import { DocumentPlanningError } from "../model/document-planning-error.js";

export interface DocumentProfileDescriptionReader {
  describeV2(request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentAuthoringProfileDescriptionV2>;
  describeV3(request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentAuthoringProfileDescriptionV3>;
}

export async function loadV2ProfileDescription(
  reader: DocumentProfileDescriptionReader | undefined,
  profile: DocumentPlanningProfileSnapshot,
  request: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }
): Promise<
  | DocumentAuthoringProfileDescriptionV2
  | DocumentAuthoringProfileDescriptionV3
  | undefined
> {
  if (profile.schemaVersion !== 2 && profile.schemaVersion !== 3) {
    return undefined;
  }
  const description = profile.schemaVersion === 3
    ? await reader?.describeV3(request)
    : await reader?.describeV2(request);
  if (description === undefined) {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
      "Document Plan v2 requires a stable profile semantic description."
    );
  }
  return description;
}
