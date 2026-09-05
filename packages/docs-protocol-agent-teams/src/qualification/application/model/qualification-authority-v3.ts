import type {
  ConsumerUpgradeAuthorityV2
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
