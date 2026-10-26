import type { ConsumerIntegrationDesiredStateV1 } from "../domain/model.js";
import { record, array, string } from "./cohort-authority-fetch.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

export function selectedLifecycleState(
  events: readonly unknown[],
  cohortId: string,
): {
  readonly qualificationEventDigest: string;
  readonly state: string;
  readonly supportUntil: unknown;
} {
  const selected = events
    .map((value) => record(value, "Cohort lifecycle event"))
    .filter((event) => event["cohort_id"] === cohortId)
    .map((event) => {
      const sequence = event["sequence"];
      if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_AUTHORITY_INVALID",
          `${cohortId} has an invalid lifecycle sequence.`,
        );
      }
      return { event, sequence: Number(sequence) };
    })
    .toSorted((left, right) => left.sequence - right.sequence);
  if (new Set(selected.map(({ sequence }) => sequence)).size !== selected.length) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${cohortId} has duplicate lifecycle sequences.`,
    );
  }
  const qualification = selected.filter(({ event }) => event["state"] === "QUALIFIED");
  const last = selected.at(-1);
  if (qualification.length !== 1 || last === undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${cohortId} does not have one immutable QUALIFIED lifecycle event.`,
    );
  }
  return {
    qualificationEventDigest: string(
      qualification[0]!.event["event_digest"],
      "QUALIFIED event digest",
    ),
    state: string(last.event["state"], "Current Cohort lifecycle state"),
    supportUntil: last.event["support_until"],
  };
}

export function assertSelectable(
  source: Record<string, unknown>,
  state: string,
  repository: ConsumerIntegrationDesiredStateV1["repository"],
): void {
  if (state === "RECOMMENDED") {
    return;
  }
  const canaries = array(source["canary_repositories"], "Cohort canary repositories").map((entry) =>
    record(entry, "Cohort canary repository"),
  );
  if (
    ["QUALIFIED", "CANARY"].includes(state) &&
    canaries.some((entry) => String(entry["repository_id"]) === repository.id)
  ) {
    return;
  }
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_COHORT_NOT_SELECTABLE",
    `${String(source["cohort_id"])} is ${state} and is not selectable for repository ${repository.id}.`,
  );
}
