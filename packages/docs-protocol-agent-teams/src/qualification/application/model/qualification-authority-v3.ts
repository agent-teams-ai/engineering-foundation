import type {
  ConsumerQualificationAuthorityV3,
  ConsumerUpgradeAuthorityV2,
} from "../../../consumer-integration/application-api.js";

export interface DocsProtocolQualificationAuthorityV3Request {
  readonly cohortId: string;
  readonly registry: Record<string, unknown>;
  readonly repository: {
    readonly provider: "github";
    readonly id: string;
    readonly nameWithOwner: string;
  };
  readonly revision: string;
}

export type DocsProtocolQualificationAuthorityV3 = ConsumerUpgradeAuthorityV2;

export interface DocsProtocolQualificationCohortV3AuthorityRequest {
  readonly cohortId: string;
  readonly registry: Record<string, unknown>;
  readonly repository: {
    readonly provider: "github";
    readonly id: string;
    readonly nameWithOwner: string;
  };
  readonly revision: string;
}

export type DocsProtocolQualificationCohortV3Authority = ConsumerQualificationAuthorityV3;
