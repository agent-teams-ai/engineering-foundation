import {
  assertConsumerIntegrationDesiredStateV3,
  describeCanonicalConsumerAssets,
  observeQualifiedPnpmLockfileV2
} from "../consumer-integration/composition/qualification-v3-boundary.js";
import type {
  DocsProtocolQualificationLockfileObservationV3,
  DocsProtocolQualificationLockfileObservationV3Request
} from "./v3-contract.js";

function assertDocsProtocolQualificationV3ProfileAuthority(
  profile: DocsProtocolQualificationLockfileObservationV3Request["profile"]
): void {
  assertConsumerIntegrationDesiredStateV3(profile);
  const canonicalAssets = describeCanonicalConsumerAssets(profile.cohort);
  if (canonicalAssets.skillDigest !== profile.cohort.assets.skillDigest ||
    canonicalAssets.callerWorkflowDigest !== profile.cohort.assets.callerWorkflowDigest ||
    canonicalAssets.assetCatalogDigest !== profile.cohort.assets.assetCatalogDigest ||
    canonicalAssets.transitionCatalogDigest !== profile.cohort.assets.transitionCatalogDigest) {
    throw new Error("Qualification v3 Cohort asset digests do not match this exact package build.");
  }
}

/**
 * Observes a registry/SRI-bound five-coordinate lockfile against trusted Profile v3 authority.
 * It does not accept package coordinates as caller-supplied qualification evidence.
 */
export function observeDocsProtocolQualificationV3Lockfile(
  request: DocsProtocolQualificationLockfileObservationV3Request
): DocsProtocolQualificationLockfileObservationV3 {
  assertDocsProtocolQualificationV3ProfileAuthority(request.profile);
  return Object.freeze({
    runtimeClosureDigest: observeQualifiedPnpmLockfileV2(
      request.lockfileBytes,
      request.profile
    )
  });
}
