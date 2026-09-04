import {
  projectQualificationAuthorityV2,
  type ConsumerUpgradeAuthorityV2
} from "../consumer-integration/composition/qualification-v3-boundary.js";

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

export function projectDocsProtocolQualificationV3Authority(
  request: DocsProtocolQualificationAuthorityV3Request
): DocsProtocolQualificationAuthorityV3 {
  return projectQualificationAuthorityV2(request);
}
