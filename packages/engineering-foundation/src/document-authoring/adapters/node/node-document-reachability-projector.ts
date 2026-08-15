import type { DocumentReachabilityProjection } from "../../application/model/document-command.js";
import type {
  DocumentAuthorityEvidence,
} from "../../application/model/document-catalog.js";
import type { DocumentPlanContract as DocumentPlan } from "../../application/model/document-planning.js";
import type { DocumentPlanningProfileReader } from "../../application/ports/document-planning-profile-reader.js";
import type { DocumentReachabilityProjector } from "../../application/ports/document-reachability-projector.js";
import { projectDocumentReachability } from "../../application/policies/project-document-reachability.js";
import { selectDocumentArtifact } from "../../application/policies/resolve-document-authoring.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

function sameEvidence(
  observed: DocumentAuthorityEvidence,
  planned: DocumentAuthorityEvidence,
): boolean {
  return observed.path === planned.path &&
    observed.digest === planned.digest &&
    observed.size === planned.size;
}

function authorityMismatch(message: string): never {
  throw new DocumentPlanningError(
    "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
    message,
  );
}

/**
 * Projects the manual reachability action from the exact profile authority
 * captured by the plan. It never infers a profile from repository layout.
 */
export class NodeDocumentReachabilityProjector
implements DocumentReachabilityProjector {
  readonly #profiles: DocumentPlanningProfileReader;

  constructor(profiles: DocumentPlanningProfileReader) {
    this.#profiles = profiles;
  }

  async project(input: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
  }): Promise<DocumentReachabilityProjection> {
    const profile = await this.#profiles.read({
      consumerRoot: input.consumerRoot,
      path: input.plan.authority.profile.path,
    });
    if (!sameEvidence(profile.evidence, input.plan.authority.profile)) {
      authorityMismatch(
        "Document authoring profile changed after the plan was compiled.",
      );
    }
    if (profile.projectId !== input.plan.projectId) {
      authorityMismatch(
        "Document authoring profile no longer identifies the planned project.",
      );
    }
    const artifact = selectDocumentArtifact(profile, input.plan.intent.type);
    const heading = artifact.heading.kind === "title"
      ? input.plan.intent.title
      : `${input.plan.intent.id}: ${input.plan.intent.title}`;
    return projectDocumentReachability({
      artifact,
      destination: input.plan.destination,
      heading,
    });
  }
}
