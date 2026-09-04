import {
  canonicalConsumerRoot,
  MAXIMUM_PROFILE_BYTES,
  readStableConsumerFile
} from "../adapters/node-consumer-repository-files.js";

export {
  describeCanonicalConsumerAssets
} from "../application/policies/consumer-integration-assets.js";
export {
  assertConsumerIntegrationDesiredStateV3
} from "../application/policies/consumer-integration-desired-state.js";
export {
  QUALIFIED_DOCS_COHORT_V2_PACKAGES
} from "../application/policies/qualified-docs-cohort-v2.js";
export {
  assertQualifiedPnpmLockfileV2
} from "../adapters/pnpm-lockfile-validator-v2.js";
export type {
  ConsumerIntegrationDigest,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2,
  QualifiedDocsCohortV1,
  QualifiedDocsPackageCoordinateV2,
  QualifiedDocsCohortV2
} from "../domain/model.js";

/** Filesystem observation stays behind the consumer-integration adapter boundary. */
export async function readManagedQualificationProfileInput(
  consumerRoot: string,
  integrationPath: string
): Promise<{
  readonly consumerRoot: string;
  readonly profile: { readonly schemaVersion?: unknown };
}> {
  const canonicalRoot = await canonicalConsumerRoot(consumerRoot);
  const observation = await readStableConsumerFile(
    canonicalRoot,
    integrationPath,
    MAXIMUM_PROFILE_BYTES,
    true
  );
  if (observation.state !== "file") {
    throw new TypeError("Managed integration profile is unavailable.");
  }
  return Object.freeze({
    consumerRoot: canonicalRoot,
    profile: JSON.parse(Buffer.from(observation.bytes).toString("utf8")) as {
      readonly schemaVersion?: unknown;
    }
  });
}
