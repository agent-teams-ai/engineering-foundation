import { createHash } from "node:crypto";
import type { QualifiedDocsCohortBindingV1 } from "../dist/consumer-integration/index.js";
type RegistryCohort = Omit<QualifiedDocsCohortBindingV1, "schemaVersion" | "schemas"> & {
  schemas: { consumerIntegration: number; managedState: number; docsProtocol: number };
};
export const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox",
};
export const V2_PACKAGE_NAMES = [
  ["repositoryMutation", "@agent-teams/repository-mutation"],
  ["documentAuthoring", "@agent-teams/document-authoring"],
  ["docsProtocol", "@agent-teams/docs-protocol"],
  ["docsProtocolAgentTeams", "@agent-teams/docs-protocol-agent-teams"],
  ["engineeringFoundation", "@agent-teams/engineering-foundation"],
];

const canonical = (entry: unknown): string =>
  Array.isArray(entry)
    ? `[${entry.map(canonical).join(",")}]`
    : entry !== null && typeof entry === "object"
      ? `{${Object.keys(entry)
          .toSorted()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((entry as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`
      : JSON.stringify(entry);
export function authorityDigest(value: Record<string, unknown>, field: string, domain: string) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  return `sha256:${createHash("sha256").update(canonical({ domain, body })).digest("hex")}`;
}

export function bindRegistry<
  T extends { cohorts: Record<string, unknown>[]; events: Record<string, unknown>[] },
>(registry: T) {
  for (const source of registry.cohorts) {
    source.record_digest = authorityDigest(
      source,
      "record_digest",
      "agent-teams.docs-qualified-cohort/v2",
    );
  }
  let previous: string | null = null;
  for (const event of registry.events) {
    event.previous_event_digest = previous;
    const eventDigest = authorityDigest(
      event,
      "event_digest",
      "agent-teams.docs-qualified-cohort-event/v1",
    );
    event.event_digest = eventDigest;
    previous = eventDigest;
  }
  return registry;
}
export function centralRegistry(cohort: RegistryCohort) {
  return {
    schema_version: 1,
    cohorts: [
      {
        cohort_id: cohort.cohortId,
        channel: cohort.channel,
        record_digest: cohort.recordDigest,
        eligible_after: cohort.eligibleAfter,
        upgrade_from: cohort.upgradeFrom,
        rollback_to: cohort.rollbackTo,
        evidence_references: [],
        packages: [
          { name: "@agent-teams/docs-protocol", ...cohort.packages.docsProtocol },
          {
            name: "@agent-teams/engineering-foundation",
            ...cohort.packages.engineeringFoundation,
          },
        ],
        reusable_workflow: {
          repository: cohort.workflow.repository,
          path: cohort.workflow.path,
          revision: cohort.workflow.revision,
          blob_sha: cohort.workflow.blobSha,
        },
        assets: {
          skill: { digest: cohort.assets.skillDigest },
          caller_workflow: { rendered_digest: cohort.assets.callerWorkflowDigest },
          asset_catalog: { digest: cohort.assets.assetCatalogDigest },
          transition_catalog: { digest: cohort.assets.transitionCatalogDigest },
        },
        schemas: {
          consumer_integration: cohort.schemas.consumerIntegration,
          consumer_plan: 1,
          managed_state: cohort.schemas.managedState,
          foundation_plan: 1,
          foundation_journal: 1,
          foundation_receipt: 1,
          foundation_envelope: 5,
          docs_protocol: cohort.schemas.docsProtocol,
        },
        runtime: { node: cohort.runtime.node, pnpm: cohort.runtime.pnpm },
        runtime_closure: { digest: cohort.runtime.runtimeClosureDigest },
        canary_repositories: [{ repository_id: Number(REPOSITORY.id) }],
      },
    ],
    events: [
      {
        sequence: 1,
        cohort_id: cohort.cohortId,
        state: "QUALIFIED",
        event_digest: cohort.qualificationEventDigest,
      },
      {
        sequence: 2,
        cohort_id: cohort.cohortId,
        state: "RECOMMENDED",
        event_digest: `sha256:${"9".repeat(64)}`,
      },
    ],
  };
}
