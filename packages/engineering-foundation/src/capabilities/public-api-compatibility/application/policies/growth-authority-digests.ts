import type {
  GrowthAuthorityCompletion,
  GrowthAuthorityGrant,
  GrowthAuthorityRequest,
  GrowthPromotionPlan,
} from "../model/growth-authority.js";

import type { GrowthDigest } from "../model/growth-observation.js";
import type { GrowthReport } from "../model/growth-report.js";

import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { hashGrowthPayload } from "./compare-growth-surfaces.js";

import { validateGrowthAuthorityRequest } from "./growth-authority-request.js";

export function growthAuthorityRequestDigest(
  request: GrowthAuthorityRequest,
  fingerprint: ChangeFingerprint,
): GrowthDigest {
  return hashGrowthPayload(
    {
      domain: "reviewrouter:sdk-growth-authority:request:3",
      request: validateGrowthAuthorityRequest(request),
    },
    fingerprint,
  );
}
export function growthAuthorityGrantDigest(
  grant: GrowthAuthorityGrant,
  fingerprint: ChangeFingerprint,
): GrowthDigest {
  return hashGrowthPayload(
    { domain: "reviewrouter:sdk-growth-authority:grant:3", grant },
    fingerprint,
  );
}
export function growthAuthorityCompletionDigest(
  completion: GrowthAuthorityCompletion,
  fingerprint: ChangeFingerprint,
): GrowthDigest {
  return hashGrowthPayload(
    { domain: "reviewrouter:sdk-growth-authority:completion:3", completion },
    fingerprint,
  );
}
export function growthPromotionPlanDigest(
  plan: GrowthPromotionPlan,
  fingerprint: ChangeFingerprint,
): GrowthDigest {
  return hashGrowthPayload(
    { domain: "reviewrouter:sdk-growth-authority:promotion-plan:3", plan },
    fingerprint,
  );
}
export function growthReportAuthorityDigests(
  report: GrowthReport,
  fingerprint: ChangeFingerprint,
): { coverageDigest: GrowthDigest; phasesDigest: GrowthDigest } {
  return {
    coverageDigest: hashGrowthPayload(
      { domain: "reviewrouter:sdk-growth-authority:coverage:3", coverage: report.coverage },
      fingerprint,
    ),
    phasesDigest: hashGrowthPayload(
      { domain: "reviewrouter:sdk-growth-authority:phases:3", phases: report.phases },
      fingerprint,
    ),
  };
}
