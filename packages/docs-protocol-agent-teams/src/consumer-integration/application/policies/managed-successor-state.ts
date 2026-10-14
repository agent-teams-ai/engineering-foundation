import { projectManagedSuccessorStateBody } from "./consumer-integration-assets.js";
import type {
  ConsumerIntegrationDesiredStateV3,
  ConsumerUpgradeAuthorityV3,
  ManagedSuccessorAssetDigests,
  ManagedSuccessorProfile,
  ManagedSuccessorSelectionV3
} from "../../domain/model.js";

export type {
  ManagedSuccessorAssetDigests, ManagedSuccessorProfile
} from "../../domain/model.js";

/** Projects inert successor data; it neither selects a cohort nor writes a consumer file. */
export function projectManagedSuccessorState(
  profile: ManagedSuccessorProfile,
  assets: ManagedSuccessorAssetDigests
): string {
  return projectManagedSuccessorStateBody(profile, assets);
}

export type ManagedSuccessorSelectionResultV3 =
  | { readonly status: "selected"; readonly selection: ManagedSuccessorSelectionV3 }
  | {
      readonly status: "rejected";
      readonly code:
        | "DOCS_CONSUMER_COHORT_NOT_SELECTABLE"
        | "DOCS_CONSUMER_COHORT_NOT_ELIGIBLE"
        | "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN";
      readonly message: string;
    };

/** Applies the lifecycle boundary before constructing any writable Profile4 state. */
export function selectManagedSuccessorProfileV3(
  current: ConsumerIntegrationDesiredStateV3,
  authority: ConsumerUpgradeAuthorityV3,
  nowMilliseconds: number
): ManagedSuccessorSelectionResultV3 {
  const cohort = authority.cohort;
  if (!cohort.upgradeFrom.includes(current.cohort.cohortId)) {
    return {
      status: "rejected",
      code: "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
      message: `Central authority does not permit a transition from ${current.cohort.cohortId}.`
    };
  }
  if (cohort.lifecycleState === "QUALIFIED" ||
    (cohort.lifecycleState === "CANARY" && !cohort.canaryRepositoryIds.includes(current.repository.id))) {
    return {
      status: "rejected",
      code: "DOCS_CONSUMER_COHORT_NOT_SELECTABLE",
      message: `${cohort.cohortId} is ${cohort.lifecycleState} and is not selected for repository ${current.repository.id}.`
    };
  }
  const eligibleAt = Date.parse(cohort.eligibleAfter);
  if (!Number.isFinite(eligibleAt) || eligibleAt > nowMilliseconds) {
    return {
      status: "rejected",
      code: "DOCS_CONSUMER_COHORT_NOT_ELIGIBLE",
      message: `${cohort.cohortId} is not eligible before ${cohort.eligibleAfter}.`
    };
  }
  const { lifecycleState, canaryRepositoryIds: _canaryRepositoryIds, ...binding } = cohort;
  return {
    status: "selected",
    selection: Object.freeze({
      profile: Object.freeze({
        schemaVersion: 4,
        repository: current.repository,
        integrationRoot: ".",
        packageManager: "pnpm",
        profilePath: current.profilePath,
        skillPath: current.skillPath,
        callerWorkflowPath: current.callerWorkflowPath,
        managedStatePath: current.managedStatePath,
        ...(current.governedDocsRoots === undefined
          ? {}
          : { governedDocsRoots: current.governedDocsRoots }),
        qualification: current.qualification,
        cohort: binding
      }),
      lifecycleState,
      repositoryId: current.repository.id
    })
  };
}
