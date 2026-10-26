import { projectCohortV3Binding } from "./cohort-v3-authority-projector.js";
import { validateCohortV3Binding, restorationJson } from "../application-api.js";
import { createLazyPackedManagedRuntimePolicyObserver } from "./unselected-cohort-v3-loader.js";
const observePolicy = createLazyPackedManagedRuntimePolicyObserver();
import type {
  ConsumerIntegrationDesiredState,
  ConsumerUpgradeAuthorityV3,
} from "../domain/model.js";
import { array, record } from "./cohort-authority-fetch.js";
import { assertCohortEventChainV2, assertDigest } from "./cohort-v2-authority-validator.js";
import { selectedLifecycleState, assertSelectable } from "./cohort-authority-lifecycle.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

export function assertManagedRollbackSource(input: {
  readonly registry: Record<string, unknown>;
  readonly cohortId: string;
  readonly rollbackFrom: string;
  readonly repository: ConsumerIntegrationDesiredState["repository"];
  readonly now: number;
  readonly revision: string;
  readonly expected?: ConsumerUpgradeAuthorityV3["cohort"];
}): void {
  if (!Number.isFinite(input.now)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Rollback authority observation time is invalid.",
    );
  }
  const matches = array(input.registry["cohorts"], "Qualified Cohorts")
    .map((value) => record(value, "Rollback source Cohort"))
    .filter((value) => value["cohort_id"] === input.rollbackFrom);
  const source = matches[0];
  if (
    matches.length !== 1 ||
    source?.["cohort_generation"] !== 3 ||
    !array(source["rollback_to"], "Rollback targets").includes(input.cohortId) ||
    !array(source["upgrade_from"], "Upgrade origins").includes(input.cohortId)
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
      "Rollback requires an explicit current generation3 source edge.",
    );
  }
  assertDigest(source, "record_digest", "agent-teams.docs-qualified-cohort/v3");
  const events = array(input.registry["events"], "Cohort lifecycle events");
  assertCohortEventChainV2(events, source);
  const sourceLifecycle = selectedLifecycleState(events, input.rollbackFrom);
  const sourceState = sourceLifecycle.state;
  const wasRecommended = events
    .map((value) => record(value, "Cohort lifecycle event"))
    .some((event) => event["cohort_id"] === input.rollbackFrom && event["state"] === "RECOMMENDED");
  if (!wasRecommended) {
    assertSelectable(source, "QUALIFIED", input.repository);
  }
  if (
    sourceState === "SUPERSEDED" &&
    (typeof sourceLifecycle.supportUntil !== "string" ||
      !Number.isFinite(Date.parse(sourceLifecycle.supportUntil)) ||
      input.now >= Date.parse(sourceLifecycle.supportUntil))
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_NOT_SELECTABLE",
      "Rollback source support has expired.",
    );
  }
  if (!["QUALIFIED", "CANARY", "RECOMMENDED", "SUSPENDED", "SUPERSEDED"].includes(sourceState)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_NOT_SELECTABLE",
      "Rollback source is not a supported current binding.",
    );
  }

  const binding = projectCohortV3Binding({
    registry: input.registry,
    cohortId: input.rollbackFrom,
    revision: input.revision,
    repository: input.repository,
  });
  validateCohortV3Binding(binding, observePolicy());
  if (
    input.expected !== undefined &&
    restorationJson(binding) !== restorationJson(input.expected)
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Recorded rollback source binding changed.",
    );
  }
}
