/* oxlint-disable max-lines -- mirrors the closed local v1 and v2 authority contracts */
import type {
  ConsumerUpgradeAuthorityReader
} from "../application/ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../domain/model.js";
import {
  assertQualifiedDocsCohortBindingV1,
  assertQualifiedDocsCohortBindingV2
} from "../application/policies/consumer-integration-desired-state.js";
import {
  QUALIFIED_DOCS_COHORT_V2_PACKAGES
} from "../application/policies/qualified-docs-cohort-v2.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";

const AUTHORITY_REPOSITORY = "agent-teams-ai/.github";
const AUTHORITY_PATH = "governance/docs-qualified-cohorts.json";
const AUTHORITY_API = `https://api.github.com/repos/${AUTHORITY_REPOSITORY}`;
const AUTHORITY_RAW = `https://raw.githubusercontent.com/${AUTHORITY_REPOSITORY}`;
const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const SHA256 = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const PACKAGE_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const AUTHORITY_PATH_VALUE = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^/]+(?:\/[^/]+)*$/u;
const AUTHORITY_REPOSITORY_VALUE = /^agent-teams-ai\/[A-Za-z0-9_.-]+$/u;
const MAXIMUM_AUTHORITY_BYTES = 8 * 1024 * 1024;
const V1_MANAGED_PACKAGES = [
  "@agent-teams/docs-protocol",
  "@agent-teams/engineering-foundation"
] as const;

type AuthorityFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>;

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one plain object.`
    );
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one bounded array.`
    );
  }
  return value;
}

function string(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
    value.includes("\u0000")) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one bounded string.`
    );
  }
  return value;
}

function invalid(message: string): never {
  throw new ConsumerIntegrationNodeError("DOCS_CONSUMER_AUTHORITY_INVALID", message);
}

function assertPattern(value: unknown, pattern: RegExp, subject: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid(`${subject} is invalid.`);
  }
}

function assertPositiveInteger(value: unknown, subject: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    invalid(`${subject} must be one positive safe integer.`);
  }
}

function assertPath(value: unknown, subject: string): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 || !AUTHORITY_PATH_VALUE.test(value)) {
    invalid(`${subject} must be one bounded repository-relative path.`);
  }
}

async function responseBytes(response: Response, subject: string): Promise<Uint8Array> {
  if (!response.ok) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_UNAVAILABLE",
      `${subject} returned HTTP ${response.status}.`
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAXIMUM_AUTHORITY_BYTES) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} exceeds the authority size limit.`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_AUTHORITY_BYTES) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} has invalid or overlong bytes.`
    );
  }
  return bytes;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

async function resolveAuthorityRevision(fetcher: AuthorityFetch): Promise<string> {
  const bytes = await responseBytes(await fetcher(`${AUTHORITY_API}/commits/main`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-teams-docs" },
    redirect: "error",
    signal: timeoutSignal()
  }), "Central authority revision");
  const response = parseJsonRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const revision = response["sha"];
  if (typeof revision !== "string" || !GIT_SHA.test(revision)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central authority did not resolve one exact Git revision."
    );
  }
  return revision;
}

async function readAuthorityRegistry(
  fetcher: AuthorityFetch,
  revision: string
): Promise<Record<string, unknown>> {
  const bytes = await responseBytes(await fetcher(
    `${AUTHORITY_RAW}/${revision}/${AUTHORITY_PATH}`,
    {
      headers: { Accept: "application/json", "User-Agent": "agent-teams-docs" },
      redirect: "error",
      signal: timeoutSignal()
    }
  ), "Central Cohort registry");
  try {
    return parseJsonRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central Cohort registry is not strict duplicate-free UTF-8 JSON.",
      { cause: error }
    );
  }
}

function selectedLifecycleState(
  events: readonly unknown[],
  cohortId: string,
  generation: 1 | 2
): { readonly qualificationEventDigest: string; readonly state: string } {
  const selected = events.map((value) => record(value, "Cohort lifecycle event"))
    .filter((event) => event["cohort_id"] === cohortId)
    .map((event) => {
      if (generation === 2) {assertLifecycleEventV2(event);}
      const sequence = event["sequence"];
      if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_AUTHORITY_INVALID",
          `${cohortId} has an invalid lifecycle sequence.`
        );
      }
      return { event, sequence: Number(sequence) };
    })
    .toSorted((left, right) => left.sequence - right.sequence);
  if (new Set(selected.map(({ sequence }) => sequence)).size !== selected.length) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${cohortId} has duplicate lifecycle sequences.`
    );
  }
  const qualification = selected.filter(({ event }) => event["state"] === "QUALIFIED");
  const last = selected.at(-1);
  if (qualification.length !== 1 || last === undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${cohortId} does not have one immutable QUALIFIED lifecycle event.`
    );
  }
  return {
    qualificationEventDigest: string(
      qualification[0]!.event["event_digest"],
      "QUALIFIED event digest"
    ),
    state: string(last.event["state"], "Current Cohort lifecycle state")
  };
}

function assertSelectable(
  source: Record<string, unknown>,
  state: string,
  repository: ConsumerIntegrationDesiredStateV1["repository"]
): void {
  if (state === "RECOMMENDED") {return;}
  const canaries = array(source["canary_repositories"], "Cohort canary repositories")
    .map((entry) => record(entry, "Cohort canary repository"));
  if (["QUALIFIED", "CANARY"].includes(state) && canaries.some((entry) =>
    String(entry["repository_id"]) === repository.id
  )) {return;}
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_COHORT_NOT_SELECTABLE",
    `${String(source["cohort_id"])} is ${state} and is not selectable for repository ${repository.id}.`
  );
}

function packageRecords(source: Record<string, unknown>): Map<unknown, Record<string, unknown>> {
  const entries = array(source["packages"], "Cohort packages")
    .map((value) => record(value, "Cohort package"));
  const packageByName = new Map(entries.map((entry) => [entry["name"], entry]));
  if (packageByName.size !== entries.length) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort package identities must be unique."
    );
  }
  return packageByName;
}

function packageProjectionV1(source: Record<string, unknown>) {
  const packageByName = packageRecords(source);
  if (packageByName.size !== V1_MANAGED_PACKAGES.length ||
    V1_MANAGED_PACKAGES.some((name) => !packageByName.has(name))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v1 must select exactly its two canonical packages."
    );
  }
  const docs = packageByName.get(V1_MANAGED_PACKAGES[0])!;
  const foundation = packageByName.get(V1_MANAGED_PACKAGES[1])!;
  return {
    docsProtocol: {
      version: string(docs["version"], "Docs Protocol version"),
      integrity: string(docs["integrity"], "Docs Protocol integrity")
    },
    engineeringFoundation: {
      version: string(foundation["version"], "Foundation version"),
      integrity: string(foundation["integrity"], "Foundation integrity")
    }
  };
}

function packageProjectionV2(source: Record<string, unknown>) {
  const packageByName = packageRecords(source);
  if (packageByName.size !== QUALIFIED_DOCS_COHORT_V2_PACKAGES.length ||
    QUALIFIED_DOCS_COHORT_V2_PACKAGES.some(({ name }) => !packageByName.has(name))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v2 must select exactly its five canonical packages."
    );
  }
  return Object.fromEntries(QUALIFIED_DOCS_COHORT_V2_PACKAGES.map(({ key, name }) => {
    const coordinate = packageByName.get(name)!;
    return [key, {
      version: string(coordinate["version"], `${name} version`),
      integrity: string(coordinate["integrity"], `${name} integrity`)
    }];
  })) as QualifiedDocsCohortBindingV2["packages"];
}

type AuthorityProjection = ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2;
type CohortProjection = QualifiedDocsCohortBindingV1 | QualifiedDocsCohortBindingV2;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

const LEGACY_V1_RECORD_KEYS = [
  "assets", "canary_repositories", "channel", "cohort_id", "eligible_after",
  "evidence_references", "packages", "record_digest", "reusable_workflow", "rollback_to",
  "runtime", "runtime_closure", "schemas", "upgrade_from"
] as const;

const LEGACY_V1_SCHEMA = Object.freeze({
  consumer_integration: 1,
  consumer_plan: 1,
  managed_state: 1,
  foundation_plan: 1,
  foundation_journal: 1,
  foundation_receipt: 1,
  foundation_envelope: 5,
  docs_protocol: 1
});
const V2_SCHEMA = Object.freeze({
  consumer_integration: 3,
  managed_state: 2,
  docs_protocol: 1,
  qualification_receipt: 3,
  foundation_plan: 1,
  foundation_journal: 1,
  foundation_receipt: 1,
  foundation_envelope: 5
});
const V2_DEPENDENCY_EDGES = Object.freeze([
  ["@agent-teams/document-authoring", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol", "@agent-teams/document-authoring"],
  ["@agent-teams/docs-protocol", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/docs-protocol"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/repository-mutation"],
  ["@agent-teams/engineering-foundation", "@agent-teams/document-authoring"],
  ["@agent-teams/engineering-foundation", "@agent-teams/repository-mutation"]
] as const);
const V2_PACKAGE_KEYS = [
  "name", "role", "version", "integrity", "registry", "published_at", "provenance"
] as const;
const V2_PROVENANCE_KEYS = [
  "source_repository", "source_repository_id", "source_workflow", "source_commit",
  "workflow_run_id", "workflow_run_attempt", "registry_attestation_url", "workflow_run_url",
  "signature_verified"
] as const;
const V2_ASSET_PACKAGE = "@agent-teams/docs-protocol-agent-teams";
const V2_RUNTIME_CLOSURE_DOMAIN = "agent-teams.docs-runtime-closure/v2";

function assertReferenceArray(value: unknown, subject: string): void {
  const references = array(value, subject);
  if (references.length < 1 || references.length > 64 ||
    references.some((entry) => typeof entry !== "string" || entry.length < 1 ||
      entry.length > 2048) || new Set(references).size !== references.length) {
    invalid(`${subject} must contain 1-64 unique bounded references.`);
  }
}

function assertPackageProvenance(
  value: unknown,
  packageName: string,
  version: string
): void {
  const provenance = record(value, `${packageName} provenance`);
  if (!hasExactKeys(provenance, V2_PROVENANCE_KEYS) ||
    provenance["source_repository"] !== "agent-teams-ai/engineering-foundation" ||
    provenance["source_repository_id"] !== 1_316_243_988 ||
    provenance["signature_verified"] !== true) {
    invalid(`${packageName} provenance must match the closed current authority identity.`);
  }
  assertPath(provenance["source_workflow"], `${packageName} source workflow`);
  assertPattern(provenance["source_commit"], GIT_SHA, `${packageName} source commit`);
  assertPositiveInteger(provenance["workflow_run_id"], `${packageName} workflow run ID`);
  assertPositiveInteger(
    provenance["workflow_run_attempt"],
    `${packageName} workflow run attempt`
  );
  const runId = provenance["workflow_run_id"];
  const encodedName = packageName.replace("/", "%2f");
  if (provenance["registry_attestation_url"] !==
      `https://registry.npmjs.org/-/npm/v1/attestations/${encodedName}@${version}` ||
    provenance["workflow_run_url"] !==
      `https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${runId}`) {
    invalid(`${packageName} provenance URLs must bind its package release and workflow run.`);
  }
}

function assertPackageAuthorityV2(source: Record<string, unknown>): void {
  const entries = array(source["packages"], "Cohort packages");
  if (entries.length !== QUALIFIED_DOCS_COHORT_V2_PACKAGES.length) {
    invalid("Qualified Cohort v2 must select exactly its five canonical packages.");
  }
  entries.forEach((value, index) => {
    const coordinate = record(value, "Cohort package");
    const expected = QUALIFIED_DOCS_COHORT_V2_PACKAGES[index]!;
    const role = expected.direct ? "direct" : "transitive";
    if (!hasExactKeys(coordinate, V2_PACKAGE_KEYS) || coordinate["name"] !== expected.name ||
      coordinate["role"] !== role || coordinate["registry"] !== "https://registry.npmjs.org/") {
      invalid("Qualified Cohort v2 package order, identity, role, and keys must be exact.");
    }
    assertPattern(coordinate["version"], PACKAGE_VERSION, `${expected.name} version`);
    assertPattern(coordinate["integrity"], PACKAGE_INTEGRITY, `${expected.name} integrity`);
    assertPattern(coordinate["published_at"], TIMESTAMP, `${expected.name} published timestamp`);
    assertPackageProvenance(coordinate["provenance"], expected.name, coordinate["version"]);
  });
}

function assertWorkflowAuthorityV2(value: unknown): void {
  const workflow = record(value, "Cohort reusable workflow");
  if (!hasExactKeys(workflow, [
    "repository", "repository_id", "path", "revision", "blob_sha"
  ]) || workflow["repository"] !== AUTHORITY_REPOSITORY ||
    workflow["repository_id"] !== 1_316_243_981 ||
    workflow["path"] !== ".github/workflows/docs-protocol-check.yml") {
    invalid("Qualified Cohort v2 reusable workflow authority must match its exact identity.");
  }
  assertPattern(workflow["revision"], GIT_SHA, "Workflow revision");
  assertPattern(workflow["blob_sha"], GIT_SHA, "Workflow blob SHA");
}

function assertAssetEntry(
  value: unknown,
  subject: string,
  callerWorkflow: boolean
): void {
  const asset = record(value, subject);
  const keys = callerWorkflow
    ? ["package", "path", "digest", "rendered_digest"]
    : ["package", "path", "digest"];
  if (!hasExactKeys(asset, keys) || asset["package"] !== V2_ASSET_PACKAGE) {
    invalid(`${subject} must match its closed adapter-package asset shape.`);
  }
  assertPath(asset["path"], `${subject} path`);
  assertPattern(asset["digest"], SHA256, `${subject} digest`);
  if (callerWorkflow) {
    assertPattern(asset["rendered_digest"], SHA256, `${subject} rendered digest`);
  }
}

function assertAssetsAuthorityV2(value: unknown): void {
  const assets = record(value, "Cohort assets");
  if (!hasExactKeys(assets, [
    "skill", "caller_workflow", "asset_catalog", "transition_catalog"
  ])) {
    invalid("Qualified Cohort v2 assets must match the closed four-entry shape.");
  }
  assertAssetEntry(assets["skill"], "Cohort Skill asset", false);
  assertAssetEntry(assets["caller_workflow"], "Cohort caller workflow asset", true);
  assertAssetEntry(assets["asset_catalog"], "Cohort asset catalog", false);
  assertAssetEntry(assets["transition_catalog"], "Cohort transition catalog", false);
}

function assertRuntimeAuthorityV2(value: unknown): void {
  const runtime = record(value, "Cohort runtime");
  const applyPlatforms = runtime["apply_platforms"];
  const checkPlatforms = runtime["check_plan_platforms"];
  if (!hasExactKeys(runtime, ["node", "pnpm", "apply_platforms", "check_plan_platforms"]) ||
    runtime["node"] !== ">=24.18.0 <25" || runtime["pnpm"] !== ">=11.17.0 <12" ||
    !Array.isArray(applyPlatforms) || applyPlatforms.join("\u0000") !== "linux\u0000macos" ||
    !Array.isArray(checkPlatforms) ||
    checkPlatforms.join("\u0000") !== "linux\u0000macos\u0000windows") {
    invalid("Qualified Cohort v2 runtime must match the exact current platform contract.");
  }
}

function assertRuntimeClosureAuthorityV2(value: unknown): void {
  const closure = record(value, "Cohort runtime closure");
  if (!hasExactKeys(closure, [
    "schema_version", "domain", "package_manager", "lockfile_version", "package_count",
    "projection_path", "digest"
  ]) || closure["schema_version"] !== 2 ||
    closure["domain"] !== V2_RUNTIME_CLOSURE_DOMAIN ||
    closure["package_manager"] !== "pnpm@11.20.0" || closure["lockfile_version"] !== "9.0" ||
    !Number.isSafeInteger(closure["package_count"]) || Number(closure["package_count"]) < 5 ||
    Number(closure["package_count"]) > 2048) {
    invalid("Qualified Cohort v2 runtime closure must match the closed current contract.");
  }
  assertPattern(closure["digest"], SHA256, "Runtime closure digest");
  const digest = closure["digest"].slice("sha256:".length);
  if (closure["projection_path"] !==
    `governance/docs-runtime-closures/sha256-${digest}.json`) {
    invalid("Qualified Cohort v2 runtime closure projection path must bind its digest.");
  }
}

function assertCanaryRepositoriesV2(value: unknown): void {
  const canaries = array(value, "Cohort canary repositories");
  if (canaries.length < 1 || canaries.length > 32) {
    invalid("Qualified Cohort v2 must contain 1-32 canary repositories.");
  }
  canaries.forEach((entry) => {
    const canary = record(entry, "Cohort canary repository");
    if (!hasExactKeys(canary, ["repository_id", "repository"])) {
      invalid("Qualified Cohort v2 canary repository keys must be exact.");
    }
    assertPositiveInteger(canary["repository_id"], "Canary repository ID");
    assertPattern(canary["repository"], AUTHORITY_REPOSITORY_VALUE, "Canary repository");
  });
}

function assertNestedAuthorityV2(source: Record<string, unknown>): void {
  assertPackageAuthorityV2(source);
  assertWorkflowAuthorityV2(source["reusable_workflow"]);
  assertAssetsAuthorityV2(source["assets"]);
  assertRuntimeAuthorityV2(source["runtime"]);
  assertRuntimeClosureAuthorityV2(source["runtime_closure"]);
  assertCanaryRepositoriesV2(source["canary_repositories"]);
  assertReferenceArray(source["evidence_references"], "Cohort evidence references");
  if (array(source["upgrade_from"], "Cohort upgrade origins").length < 1) {
    invalid("Qualified Cohort v2 must name at least one upgrade origin.");
  }
}

const V2_LIFECYCLE_STATES = new Set([
  "PUBLISHED_UNQUALIFIED", "VERIFIED", "COOLDOWN", "QUALIFIED", "CANARY", "RECOMMENDED",
  "SUPERSEDED", "SUPPORT_ENDED", "SUSPENDED", "WITHDRAWN"
]);

function assertCanaryEvidenceV2(value: unknown): void {
  const evidence = record(value, "Cohort canary evidence");
  if (!hasExactKeys(evidence, [
    "repository_id", "repository", "merge_revision", "observed_cohort_id",
    "observed_record_digest", "observed_event_digest", "required_context", "integration_id",
    "conclusion", "check_run_id", "check_run_url", "workflow_run_id", "workflow_id",
    "caller_workflow_path", "caller_workflow_digest"
  ]) || evidence["conclusion"] !== "success") {
    invalid("Qualified Cohort v2 canary evidence must match its closed current shape.");
  }
  for (const [key, subject] of [
    ["repository_id", "Canary evidence repository ID"],
    ["integration_id", "Canary evidence integration ID"],
    ["check_run_id", "Canary evidence check run ID"],
    ["workflow_run_id", "Canary evidence workflow run ID"],
    ["workflow_id", "Canary evidence workflow ID"]
  ] as const) {
    assertPositiveInteger(evidence[key], subject);
  }
  assertPattern(evidence["repository"], AUTHORITY_REPOSITORY_VALUE, "Canary evidence repository");
  assertPattern(evidence["merge_revision"], GIT_SHA, "Canary evidence merge revision");
  assertPattern(
    evidence["observed_record_digest"], SHA256, "Canary evidence observed record digest"
  );
  assertPattern(
    evidence["observed_event_digest"], SHA256, "Canary evidence observed event digest"
  );
  assertPattern(
    evidence["caller_workflow_digest"], SHA256, "Canary evidence caller workflow digest"
  );
  if (typeof evidence["observed_cohort_id"] !== "string" ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(evidence["observed_cohort_id"]) ||
    typeof evidence["required_context"] !== "string" ||
    evidence["required_context"].length < 1 || evidence["required_context"].length > 256 ||
    typeof evidence["check_run_url"] !== "string" ||
    !/^https:\/\/github\.com\/agent-teams-ai\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]+(?:\/job\/[1-9][0-9]+)?$/u
      .test(evidence["check_run_url"]) || typeof evidence["caller_workflow_path"] !== "string" ||
    !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(evidence["caller_workflow_path"])) {
    invalid("Qualified Cohort v2 canary evidence contains invalid bounded references.");
  }
}

function assertLifecycleEventV2(event: Record<string, unknown>): void {
  if (!hasExactKeys(event, [
    "sequence", "cohort_id", "state", "effective_at", "support_until",
    "evidence_references", "canary_evidence", "previous_event_digest", "event_digest"
  ]) || !V2_LIFECYCLE_STATES.has(event["state"] as string)) {
    invalid("Qualified Cohort v2 lifecycle events must match the closed current shape.");
  }
  assertPositiveInteger(event["sequence"], "Cohort lifecycle sequence");
  assertPattern(event["effective_at"], TIMESTAMP, "Cohort lifecycle effective timestamp");
  assertPattern(event["event_digest"], SHA256, "Cohort lifecycle event digest");
  if (event["previous_event_digest"] !== null) {
    assertPattern(
      event["previous_event_digest"], SHA256, "Cohort previous lifecycle event digest"
    );
  }
  assertReferenceArray(event["evidence_references"], "Cohort lifecycle evidence references");
  const canaryEvidence = array(event["canary_evidence"], "Cohort canary evidence");
  if (canaryEvidence.length > 32 ||
    (event["state"] === "CANARY" ? canaryEvidence.length < 1 : canaryEvidence.length !== 0)) {
    invalid("Cohort lifecycle canary evidence does not match its state.");
  }
  canaryEvidence.forEach(assertCanaryEvidenceV2);
  if (event["state"] === "SUPERSEDED") {
    assertPattern(event["support_until"], TIMESTAMP, "Cohort lifecycle support timestamp");
  } else if (event["support_until"] !== null) {
    invalid("Only a SUPERSEDED Cohort lifecycle event may set support_until.");
  }
}

function assertSchemaGeneration(schemas: Record<string, unknown>, generation: 1 | 2): void {
  if (generation === 1) {
    if (!hasExactKeys(schemas, Object.keys(LEGACY_V1_SCHEMA)) ||
      Object.entries(LEGACY_V1_SCHEMA).some(([key, value]) => schemas[key] !== value)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_INVALID",
        "Historical Cohort v1 schemas must match the immutable eight-coordinate legacy shape."
      );
    }
    return;
  }
  if (!hasExactKeys(schemas, Object.keys(V2_SCHEMA)) ||
    Object.entries(V2_SCHEMA).some(([key, value]) => schemas[key] !== value)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v2 schemas must match the exact eight-coordinate authority shape."
    );
  }
}

function assertDependencyEdges(value: unknown): void {
  const edges = array(value, "Cohort dependency edges").map((entry) =>
    record(entry, "Cohort dependency edge")
  );
  const valid = edges.length === V2_DEPENDENCY_EDGES.length && edges.every((edge, index) =>
    hasExactKeys(edge, ["from", "to"]) &&
    edge["from"] === V2_DEPENDENCY_EDGES[index]?.[0] &&
    edge["to"] === V2_DEPENDENCY_EDGES[index]?.[1]
  );
  if (!valid) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v2 dependency edges must match the canonical package graph."
    );
  }
}

function recordGeneration(source: Record<string, unknown>, requested: unknown): 1 | 2 {
  const discriminator = source["cohort_generation"];
  if (requested === 1) {
    if (discriminator !== undefined || !hasExactKeys(source, LEGACY_V1_RECORD_KEYS)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_INVALID",
        "Requested Cohort v1 must have no discriminator and match the immutable legacy shape."
      );
    }
    return 1;
  }
  if (requested !== 2) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Requested Cohort generation is unknown or unsupported."
    );
  }
  if (discriminator !== 2) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Cohort generation discriminator is unknown or unsupported."
    );
  }
  if (!hasExactKeys(source, [
    ...LEGACY_V1_RECORD_KEYS, "cohort_generation", "dependency_edges"
  ])) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v2 must match its closed discriminator-bearing record shape."
    );
  }
  return 2;
}

function cohortProjection(
  source: Record<string, unknown>,
  qualificationEventDigest: string,
  requestedGeneration: 1 | 2
): CohortProjection {
  const workflow = record(source["reusable_workflow"], "Cohort reusable workflow");
  const assets = record(source["assets"], "Cohort assets");
  const skill = record(assets["skill"], "Cohort Skill asset");
  const caller = record(assets["caller_workflow"], "Cohort caller workflow asset");
  const assetCatalog = record(assets["asset_catalog"], "Cohort asset catalog");
  const transitionCatalog = record(assets["transition_catalog"], "Cohort transition catalog");
  const runtime = record(source["runtime"], "Cohort runtime");
  const runtimeClosure = record(source["runtime_closure"], "Cohort runtime closure");
  const schemas = record(source["schemas"], "Cohort schemas");
  const generation = recordGeneration(source, requestedGeneration);
  assertSchemaGeneration(schemas, generation);
  if (generation === 2) {
    assertDependencyEdges(source["dependency_edges"]);
    assertNestedAuthorityV2(source);
  }
  const projection = {
    schemaVersion: generation,
    cohortId: string(source["cohort_id"], "Cohort ID"),
    channel: string(source["channel"], "Cohort channel"),
    recordDigest: string(source["record_digest"], "Cohort record digest"),
    qualificationEventDigest,
    eligibleAfter: string(source["eligible_after"], "Cohort eligibility timestamp"),
    upgradeFrom: array(source["upgrade_from"], "Cohort upgrade origins").map((entry) =>
      string(entry, "Cohort upgrade origin")
    ),
    rollbackTo: array(source["rollback_to"], "Cohort rollback targets").map((entry) =>
      string(entry, "Cohort rollback target")
    ),
    packages: generation === 1 ? packageProjectionV1(source) : packageProjectionV2(source),
    workflow: {
      repository: string(workflow["repository"], "Workflow repository"),
      path: string(workflow["path"], "Workflow path"),
      revision: string(workflow["revision"], "Workflow revision"),
      blobSha: string(workflow["blob_sha"], "Workflow blob SHA")
    },
    assets: {
      skillDigest: string(skill["digest"], "Skill digest"),
      callerWorkflowDigest: string(caller["rendered_digest"], "Caller workflow digest"),
      assetCatalogDigest: string(assetCatalog["digest"], "Asset catalog digest"),
      transitionCatalogDigest: string(transitionCatalog["digest"], "Transition catalog digest")
    },
    schemas: {
      consumerIntegration: schemas["consumer_integration"],
      managedState: schemas["managed_state"],
      docsProtocol: schemas["docs_protocol"]
    },
    runtime: {
      node: string(runtime["node"], "Node runtime"),
      pnpm: string(runtime["pnpm"], "pnpm runtime"),
      runtimeClosureDigest: string(runtimeClosure["digest"], "Runtime closure digest")
    }
  } as CohortProjection;
  if (projection.schemaVersion === 1) {
    assertQualifiedDocsCohortBindingV1(projection);
  } else {
    assertQualifiedDocsCohortBindingV2(projection);
  }
  return Object.freeze(projection);
}

export function projectQualifiedCohortAuthority(input: {
  readonly cohortId: string;
  readonly generation: 1 | 2;
  readonly registry: Record<string, unknown>;
  readonly repository: ConsumerIntegrationDesiredState["repository"];
  readonly revision: string;
}): ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2 {
  if (input.registry["schema_version"] !== 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central Cohort registry must use contract schema_version 1."
    );
  }
  const matches = array(input.registry["cohorts"], "Qualified Cohorts")
    .map((value) => record(value, "Qualified Cohort"))
    .filter((cohort) => cohort["cohort_id"] === input.cohortId);
  if (matches.length !== 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_UNKNOWN",
      `${input.cohortId} is not one exact central Cohort.`
    );
  }
  const source = matches[0]!;
  const lifecycle = selectedLifecycleState(
    array(input.registry["events"], "Cohort lifecycle events"),
    input.cohortId,
    input.generation
  );
  assertSelectable(source, lifecycle.state, input.repository);
  const cohort = cohortProjection(source, lifecycle.qualificationEventDigest, input.generation);
  return Object.freeze({
    repository: AUTHORITY_REPOSITORY,
    path: AUTHORITY_PATH,
    revision: input.revision,
    cohort
  }) as AuthorityProjection;
}

export class GitHubCohortAuthorityReader implements ConsumerUpgradeAuthorityReader {
  readonly #fetcher: AuthorityFetch;

  public constructor(fetcher: AuthorityFetch = globalThis.fetch) {
    this.#fetcher = fetcher;
  }

  public async read(options: {
    readonly cohortId: string;
    readonly generation: 1 | 2;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
    readonly revision?: string;
  }): Promise<AuthorityProjection> {
    if (options.revision !== undefined && !GIT_SHA.test(options.revision)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_REVISION_INVALID",
        "Authority revision must be one nonzero lowercase Git SHA."
      );
    }
    const revision = await resolveAuthorityRevision(this.#fetcher);
    if (options.revision !== undefined && options.revision !== revision) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_REVISION_STALE",
        "Requested authority revision is not the current protected main revision."
      );
    }
    const registry = await readAuthorityRegistry(this.#fetcher, revision);
    return projectQualifiedCohortAuthority({ ...options, registry, revision });
  }
}

export const githubCohortAuthorityReader: ConsumerUpgradeAuthorityReader =
  Object.freeze(new GitHubCohortAuthorityReader());
