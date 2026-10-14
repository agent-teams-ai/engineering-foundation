import {
  assertCanaryRepositories,
  assertDependencyEdges,
  assertDigest,
  assertPackages,
  assertReferences,
  assertWorkflow,
  assertAssets,
  assertCohortEventChainV2
} from "./cohort-v2-authority-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  UnselectedCohortV3
} from "../application-api.js";

const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const SHA256 = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const V3_SCHEMA = Object.freeze({
  consumer_integration: 4,
  managed_state: 3,
  qualification_receipt: 1,
  docs_protocol: 1,
  foundation_plan: 1,
  foundation_journal: 1,
  foundation_receipt: 1,
  foundation_envelope: 5
});

export interface CohortV3AuthorityProjectorRequest {
  readonly cohortId: string;
  readonly registry: Record<string, unknown>;
  readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  readonly revision: string;
}

function invalid(message: string): never {
  throw new ConsumerIntegrationNodeError("DOCS_CONSUMER_AUTHORITY_INVALID", message);
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${subject} must be one plain object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 4096) {
    invalid(`${subject} must be one bounded array.`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

function assertPattern(value: unknown, pattern: RegExp, subject: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {invalid(`${subject} is invalid.`);}
}

function assertPositiveInteger(value: unknown, subject: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    invalid(`${subject} must be one positive safe integer.`);
  }
}

function assertStringArray(value: unknown, subject: string): readonly string[] {
  const entries = array(value, subject);
  if (entries.length < 1 || entries.length > 32 ||
    entries.some((entry) => typeof entry !== "string" || !COHORT_ID.test(entry)) ||
    new Set(entries).size !== entries.length) {
    invalid(`${subject} must contain unique canonical Cohort IDs.`);
  }
  return entries as readonly string[];
}

function qualificationEvent(
  events: readonly unknown[],
  cohortId: string
): { readonly state: UnselectedCohortV3["lifecycleState"]; readonly digest: string } {
  const selected = events.map((value) => record(value, "Cohort lifecycle event"))
    .filter((event) => event["cohort_id"] === cohortId);
  const qualification = selected.filter((event) => event["state"] === "QUALIFIED");
  const current = selected.at(-1);
  if (qualification.length !== 1 || current === undefined ||
    !["QUALIFIED", "CANARY", "RECOMMENDED"].includes(String(current["state"]))) {
    invalid(`${cohortId} does not have one immutable QUALIFIED event and an unselected current state.`);
  }
  assertPattern(qualification[0]!["event_digest"], SHA256, "QUALIFIED event digest");
  return {
    state: current["state"] as UnselectedCohortV3["lifecycleState"],
    digest: qualification[0]!["event_digest"]
  };
}

function validateRuntimeClosure(value: unknown): Record<string, unknown> {
  const closure = record(value, "Cohort runtime closure");
  if (!hasExactKeys(closure, [
    "schema_version", "domain", "package_manager", "lockfile_version", "package_count",
    "projection_path", "digest"
  ]) || closure["schema_version"] !== 2 ||
    closure["domain"] !== "agent-teams.docs-runtime-closure/v2" ||
    closure["package_manager"] !== "pnpm@11.20.0" || closure["lockfile_version"] !== "9.0") {
    invalid("Qualification Cohort v3 runtime closure is invalid.");
  }
  assertPositiveInteger(closure["package_count"], "Runtime closure package count");
  if (Number(closure["package_count"]) < 5) {
    invalid("Qualification Cohort v3 runtime closure must contain at least five packages.");
  }
  assertPattern(closure["digest"], SHA256, "Runtime closure digest");
  if (closure["projection_path"] !==
    `governance/docs-runtime-closures/${closure["digest"].replace(":", "-")}.json`) {
    invalid("Qualification Cohort v3 runtime closure path must bind its digest.");
  }
  return closure;
}

function validateCohortV3Source(
  source: Record<string, unknown>,
  cohortId: string
): {
  readonly policy: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
  readonly qualificationRuntime: Record<string, unknown>;
  readonly closure: Record<string, unknown>;
  readonly upgradeFrom: readonly string[];
  readonly rollbackTo: readonly string[];
} {
  assertPattern(source["cohort_id"], COHORT_ID, "Cohort ID");
  if (source["cohort_id"] !== cohortId || !["rc", "stable"].includes(String(source["channel"]))) {
    invalid("Qualification Cohort v3 identity or channel is invalid.");
  }
  assertPattern(source["candidate_digest"], SHA256, "Candidate digest");
  const policy = record(source["policy_identity"], "Cohort policy identity");
  if (!hasExactKeys(policy, ["id", "version", "digest"]) ||
    policy["id"] !== "agent-teams.docs-protocol-current-policy" ||
    policy["version"] !== "3.0.0") {
    invalid("Qualification Cohort v3 policy identity is invalid.");
  }
  assertPattern(policy["digest"], SHA256, "Policy source digest");
  assertPackages(source);
  assertDependencyEdges(source["dependency_edges"], "Qualified Cohort v3 dependency edges");
  assertWorkflow(source["reusable_workflow"]);
  const schemas = record(source["schemas"], "Cohort schemas");
  if (!hasExactKeys(schemas, Object.keys(V3_SCHEMA)) ||
    Object.entries(V3_SCHEMA).some(([key, value]) => schemas[key] !== value)) {
    invalid("Qualified Cohort v3 schemas must match the exact 4/3/1/qualificationReceipt1 authority shape.");
  }
  assertAssets(source["assets"]);
  const runtime = record(source["runtime"], "Cohort runtime");
  if (!hasExactKeys(runtime, ["selected_lane", "node", "pnpm", "qualification_runtime"]) ||
    runtime["selected_lane"] !== "node-26-managed-qualified") {
    invalid("Qualification Cohort v3 runtime identity is invalid.");
  }
  const qualificationRuntime = record(runtime["qualification_runtime"], "Cohort qualification runtime");
  if (!hasExactKeys(qualificationRuntime, ["node_version", "pnpm_version", "platform", "architecture"])) {
    invalid("Qualification Cohort v3 qualification runtime must match its closed shape.");
  }
  const closure = validateRuntimeClosure(source["runtime_closure"]);
  const upgradeFrom = assertStringArray(source["upgrade_from"], "Cohort upgrade origins");
  const rollbackTo = assertStringArray(source["rollback_to"], "Cohort rollback origins");
  if (upgradeFrom.includes(cohortId) || rollbackTo.includes(cohortId) ||
    rollbackTo.some((origin) => !upgradeFrom.includes(origin))) {
    invalid("Qualification Cohort v3 source and rollback edges are inconsistent.");
  }
  assertCanaryRepositories(source["canary_repositories"]);
  assertReferences(source["evidence_references"], "Cohort evidence references");
  assertDigest(source, "record_digest", "agent-teams.docs-qualified-cohort/v3");
  return { policy, runtime, qualificationRuntime, closure, upgradeFrom, rollbackTo };
}

/** Projects strict read-only candidate evidence; it grants no upgrade or admission authority. */
export function projectCohortV3Authority(
  input: CohortV3AuthorityProjectorRequest
): UnselectedCohortV3 {
  if (input.registry["schema_version"] !== 1) {
    invalid("Central Cohort registry must use contract schema_version 1.");
  }
  if (input.repository.provider !== "github" || !COHORT_ID.test(input.repository.id) ||
    input.repository.nameWithOwner.length === 0) {
    invalid("Qualification repository identity is invalid.");
  }
  assertPattern(input.revision, GIT_SHA, "Central authority revision");
  const cohorts = array(input.registry["cohorts"], "Qualified Cohorts")
    .map((value) => record(value, "Qualified Cohort"));
  const matches = cohorts.filter((cohort) => cohort["cohort_id"] === input.cohortId);
  if (matches.length !== 1) {
    invalid(`${input.cohortId} is not one exact central Cohort.`);
  }
  const source = matches[0]!;
  if (source["cohort_generation"] !== 3) {
    invalid("Qualification Cohort v3 projector requires cohort_generation 3.");
  }
  if (!hasExactKeys(source, [
    "cohort_generation", "cohort_id", "channel", "candidate_digest", "policy_identity",
    "packages", "dependency_edges", "reusable_workflow", "schemas", "assets", "runtime",
    "runtime_closure", "eligible_after", "upgrade_from", "rollback_to", "canary_repositories",
    "evidence_references", "record_digest"
  ])) {
    invalid("Qualified Cohort v3 must match its closed discriminator-bearing record shape.");
  }
  const validated = validateCohortV3Source(source, input.cohortId);
  const { policy, runtime, qualificationRuntime, closure, upgradeFrom, rollbackTo } = validated;
  const events = array(input.registry["events"], "Cohort lifecycle events");
  assertCohortEventChainV2(events, source);
  const lifecycle = qualificationEvent(events, input.cohortId);
  const packageByName = new Map(array(source["packages"], "Cohort packages")
    .map((value) => record(value, "Cohort package"))
    .map((entry) => [entry["name"], entry]));
  const packageCoordinate = (name: string): { version: string; integrity: `sha512-${string}` } => {
    const coordinate = packageByName.get(name);
    if (coordinate === undefined) {invalid(`${name} is missing from Cohort v3 packages.`);}
    return {
      version: coordinate["version"] as string,
      integrity: coordinate["integrity"] as `sha512-${string}`
    };
  };
  const candidate: UnselectedCohortV3 = {
    schemaVersion: 3,
    cohortId: input.cohortId,
    channel: source["channel"] as "rc" | "stable",
    candidateDigest: source["candidate_digest"] as string,
    recordDigest: source["record_digest"] as string,
    qualificationEventDigest: lifecycle.digest,
    lifecycleState: lifecycle.state,
    canaryRepositoryIds: Object.freeze(array(source["canary_repositories"], "Cohort canary repositories")
      .map((value) => String(record(value, "Cohort canary repository")["repository_id"]))),
    eligibleAfter: source["eligible_after"] as string,
    upgradeFrom: Object.freeze(upgradeFrom),
    rollbackTo: Object.freeze(rollbackTo),
    packages: Object.freeze({
      repositoryMutation: packageCoordinate("@agent-teams/repository-mutation"),
      documentAuthoring: packageCoordinate("@agent-teams/document-authoring"),
      docsProtocol: packageCoordinate("@agent-teams/docs-protocol"),
      docsProtocolAgentTeams: packageCoordinate("@agent-teams/docs-protocol-agent-teams"),
      engineeringFoundation: packageCoordinate("@agent-teams/engineering-foundation")
    }),
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: record(source["reusable_workflow"], "Cohort reusable workflow")["revision"] as string,
      blobSha: record(source["reusable_workflow"], "Cohort reusable workflow")["blob_sha"] as string
    },
    assets: {
      skillDigest: record(record(source["assets"], "Cohort assets")["skill"], "Cohort Skill asset")["digest"] as string,
      callerWorkflowDigest: record(
        record(source["assets"], "Cohort assets")["caller_workflow"], "Cohort caller workflow asset"
      )["rendered_digest"] as string,
      assetCatalogDigest: record(
        record(source["assets"], "Cohort assets")["asset_catalog"], "Cohort asset catalog"
      )["digest"] as string,
      transitionCatalogDigest: record(
        record(source["assets"], "Cohort assets")["transition_catalog"], "Cohort transition catalog"
      )["digest"] as string
    },
    schemas: {
      consumerIntegration: 4,
      managedState: 3,
      qualificationReceipt: 1,
      docsProtocol: 1
    },
    runtime: {
      policy: {
        id: "agent-teams.docs-protocol-current-policy",
        version: "3.0.0",
        digest: policy["digest"] as string
      },
      selectedLane: "node-26-managed-qualified",
      node: runtime["node"] as string,
      pnpm: runtime["pnpm"] as string,
      qualificationRuntime: {
        nodeVersion: qualificationRuntime["node_version"] as string,
        pnpmVersion: qualificationRuntime["pnpm_version"] as string,
        platform: qualificationRuntime["platform"] as string,
        architecture: qualificationRuntime["architecture"] as string
      },
      runtimeClosure: {
        domain: "agent-teams.docs-runtime-closure/v2",
        digest: closure["digest"] as string
      }
    }
  };
  return Object.freeze(candidate);
}
