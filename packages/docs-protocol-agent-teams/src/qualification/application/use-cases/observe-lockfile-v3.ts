import {
  describeCanonicalConsumerAssets,
  type ConsumerIntegrationDesiredStateV3,
  type ManagedSuccessorProfile,
  assertConsumerIntegrationDesiredStateV3,
  assertManagedSuccessorProfileV4
} from "../../../consumer-integration/application-api.js";
import type {
  DocsProtocolQualificationLockfileObservationV3,
  DocsProtocolQualificationLockfileObservationV3Request
} from "../model/v3-contract.js";

function hasExactNumber(value: unknown, expected: number): boolean {
  return typeof value === "number" && value === expected;
}

function assertDocsProtocolQualificationV3ProfileAuthority(
  profile: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile
): void {
  const schemaVersion: unknown = profile.schemaVersion;
  if (hasExactNumber(schemaVersion, 3)) {
    assertConsumerIntegrationDesiredStateV3(profile);
  } else if (hasExactNumber(schemaVersion, 4)) {
    assertManagedSuccessorProfileV4(profile);
  } else {
    throw new TypeError("Qualification v3 lockfile profile generation is invalid or unsupported.");
  }
  const canonicalAssets = profile.schemaVersion === 3
    ? describeCanonicalConsumerAssets(profile.cohort)
    : describeCanonicalConsumerAssets(profile.cohort);
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
export function createDocsProtocolQualificationV3Observer(observeLockfile: (
  bytes: Uint8Array,
  profile: ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile
) => `sha256:${string}`) {
  return function observeDocsProtocolQualificationV3Lockfile(
    request: DocsProtocolQualificationLockfileObservationV3Request | {
      readonly profile: ManagedSuccessorProfile;
      readonly lockfileBytes: Uint8Array;
    }
  ): DocsProtocolQualificationLockfileObservationV3 {
    assertDocsProtocolQualificationV3ProfileAuthority(request.profile);
    return Object.freeze({
      runtimeClosureDigest: observeLockfile(
        request.lockfileBytes,
        request.profile
      )
    });
  };
}
