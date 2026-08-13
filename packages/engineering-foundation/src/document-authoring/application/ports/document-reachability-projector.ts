import type { DocumentReachabilityProjection } from "../model/document-command.js";
import type { DocumentPlan } from "../model/document-planning.js";

/**
 * RC projection seam. GA may replace this read-only projection with a managed
 * reachability operation without changing the command use case.
 */
export interface DocumentReachabilityProjector {
  project(input: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
  }): Promise<DocumentReachabilityProjection>;
}
