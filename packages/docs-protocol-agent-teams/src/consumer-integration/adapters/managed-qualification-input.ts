import {
  canonicalConsumerRoot,
  MAXIMUM_PROFILE_BYTES,
  readStableConsumerFile,
} from "./node-consumer-repository-files.js";
import { projectQualifiedCohortAuthority } from "./github-cohort-authority-reader.js";
import {
  projectCohortV3Authority,
  type CohortV3AuthorityProjectorRequest,
} from "./cohort-v3-authority-projector.js";
import { createLazyPackedManagedRuntimePolicyObserver } from "./unselected-cohort-v3-loader.js";
import type {
  ConsumerQualificationAuthorityV3,
  ConsumerIntegrationDesiredStateV1,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2,
} from "../application-api.js";
import { bindUnselectedCohortV3 } from "../application-api.js";

export function projectQualificationAuthorityV2(input: {
  readonly cohortId: string;
  readonly registry: Record<string, unknown>;
  readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  readonly revision: string;
}): ConsumerUpgradeAuthorityV2 {
  const authority = projectQualifiedCohortAuthority({ ...input, generation: 2 });
  if (!isAuthorityV2(authority)) {
    throw new TypeError("Qualification authority projector requires Cohort generation 2.");
  }
  return authority;
}

const observePackedManagedRuntimePolicy = createLazyPackedManagedRuntimePolicyObserver();

/** Curated read-only qualification seam; ordinary upgrade readers remain generation1/2-only. */
export function projectQualificationAuthorityV3(
  input: CohortV3AuthorityProjectorRequest,
): ConsumerQualificationAuthorityV3 {
  return Object.freeze({
    repository: "agent-teams-ai/.github",
    path: "governance/docs-qualified-cohorts.json",
    revision: input.revision,
    cohort: bindUnselectedCohortV3(
      projectCohortV3Authority(input),
      observePackedManagedRuntimePolicy(),
    ),
  });
}

function isAuthorityV2(
  authority: ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2,
): authority is ConsumerUpgradeAuthorityV2 {
  return authority.cohort.schemaVersion === 2;
}

/** Filesystem observation stays behind the consumer-integration adapter boundary. */
export async function readManagedQualificationProfileInput(
  consumerRoot: string,
  integrationPath: string,
): Promise<{
  readonly consumerRoot: string;
  readonly profile: { readonly schemaVersion?: unknown };
}> {
  const canonicalRoot = await canonicalConsumerRoot(consumerRoot);
  const observation = await readStableConsumerFile(
    canonicalRoot,
    integrationPath,
    MAXIMUM_PROFILE_BYTES,
    true,
  );
  if (observation.state !== "file") {
    throw new TypeError("Managed integration profile is unavailable.");
  }
  return Object.freeze({
    consumerRoot: canonicalRoot,
    profile: JSON.parse(Buffer.from(observation.bytes).toString("utf8")) as {
      readonly schemaVersion?: unknown;
    },
  });
}
