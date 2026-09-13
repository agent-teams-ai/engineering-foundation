import type { PublicApiAuditRequest } from "../../contract/public-api-audit.js";
import type { AuditObservation } from "./public-api-observation.js";
import type { AuditEligibility } from "../policies/public-api-audit-eligibility.js";
import type { AuditGraphProjection } from "../policies/project-public-api-observation.js";
import type { PublicApiChangeSet } from "./public-api.js";

export interface AuditComparison {
  readonly pair: "A-B" | "B-C" | "A-C";
  readonly packageName: string;
  readonly scope: "historical-stored-surface" | "declaration-graph";
  readonly eligibility: AuditEligibility;
  readonly limitations: readonly string[];
  readonly findings?: PublicApiChangeSet;
  readonly beforeProjection?: AuditGraphProjection;
  readonly afterProjection?: AuditGraphProjection;
}
export interface PublicApiAuditReport {
  readonly schemaVersion: 1;
  readonly operation: "public-api-audit";
  readonly releaseEligible: false;
  readonly foundationVersion: string;
  readonly requestDigest: string;
  readonly custody: { readonly supplied: PublicApiAuditRequest["subjects"]; readonly archiveProvenanceVerified: false; readonly archiveDigestVerified: false; readonly archiveInventoryCompletenessVerified: false; readonly buildExecutionVerified: false };
  readonly observations: readonly AuditObservation[];
  readonly comparisons: readonly AuditComparison[];
  readonly evidenceComplete: boolean;
  readonly errors: readonly string[];
  readonly exitCode: 0 | 2;
}
