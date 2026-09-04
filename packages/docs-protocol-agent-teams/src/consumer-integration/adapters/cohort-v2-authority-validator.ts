import { createHash } from "node:crypto";
import {
  QUALIFIED_DOCS_COHORT_V2_PACKAGES
} from "../application/policies/qualified-docs-cohort-v2.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const SHA256 = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const PACKAGE_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const AUTHORITY_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^/]+(?:\/[^/]+)*$/u;
const AUTHORITY_REPOSITORY = /^agent-teams-ai\/[A-Za-z0-9_.-]+$/u;
const ADAPTER_PACKAGE = "@agent-teams/docs-protocol-agent-teams";
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
const PACKAGE_KEYS = [
  "name", "role", "version", "integrity", "registry", "published_at", "provenance"
] as const;
const PROVENANCE_KEYS = [
  "source_repository", "source_repository_id", "source_workflow", "source_commit",
  "workflow_run_id", "workflow_run_attempt", "registry_attestation_url", "workflow_run_url",
  "signature_verified"
] as const;
const LIFECYCLE_STATES = new Set([
  "PUBLISHED_UNQUALIFIED", "VERIFIED", "COOLDOWN", "QUALIFIED", "CANARY", "RECOMMENDED",
  "SUPERSEDED", "SUPPORT_ENDED", "SUSPENDED", "WITHDRAWN"
]);

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

function assertPath(value: unknown, subject: string): void {
  if (typeof value !== "string" || value.length > 1024 || !AUTHORITY_PATH.test(value)) {
    invalid(`${subject} must be one bounded repository-relative path.`);
  }
}

function assertReferences(value: unknown, subject: string): void {
  const references = array(value, subject);
  if (references.length < 1 || references.length > 64 ||
    references.some((entry) => typeof entry !== "string" || entry.length < 1 ||
      entry.length > 2048) || new Set(references).size !== references.length) {
    invalid(`${subject} must contain 1-64 unique bounded references.`);
  }
}

function assertProvenance(value: unknown, packageName: string, version: string): void {
  const provenance = record(value, `${packageName} provenance`);
  if (!hasExactKeys(provenance, PROVENANCE_KEYS) ||
    provenance["source_repository"] !== "agent-teams-ai/engineering-foundation" ||
    provenance["source_repository_id"] !== 1_316_243_988 ||
    provenance["signature_verified"] !== true) {
    invalid(`${packageName} provenance must match the closed current authority identity.`);
  }
  assertPath(provenance["source_workflow"], `${packageName} source workflow`);
  assertPattern(provenance["source_commit"], GIT_SHA, `${packageName} source commit`);
  assertPositiveInteger(provenance["workflow_run_id"], `${packageName} workflow run ID`);
  assertPositiveInteger(provenance["workflow_run_attempt"], `${packageName} run attempt`);
  const runId = provenance["workflow_run_id"];
  if (provenance["registry_attestation_url"] !==
      `https://registry.npmjs.org/-/npm/v1/attestations/${
        packageName.replaceAll("/", "%2f")
      }@${version}` || provenance["workflow_run_url"] !==
      `https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${runId}`) {
    invalid(`${packageName} provenance URLs must bind its package release and workflow run.`);
  }
}

function assertPackages(source: Record<string, unknown>): void {
  const entries = array(source["packages"], "Cohort packages");
  if (entries.length !== QUALIFIED_DOCS_COHORT_V2_PACKAGES.length) {
    invalid("Qualified Cohort v2 must select exactly its five canonical packages.");
  }
  entries.forEach((value, index) => {
    const coordinate = record(value, "Cohort package");
    const expected = QUALIFIED_DOCS_COHORT_V2_PACKAGES[index]!;
    if (!hasExactKeys(coordinate, PACKAGE_KEYS) || coordinate["name"] !== expected.name ||
      coordinate["role"] !== (expected.direct ? "direct" : "transitive") ||
      coordinate["registry"] !== "https://registry.npmjs.org/") {
      invalid("Qualified Cohort v2 package order, identity, role, and keys must be exact.");
    }
    assertPattern(coordinate["version"], PACKAGE_VERSION, `${expected.name} version`);
    assertPattern(coordinate["integrity"], PACKAGE_INTEGRITY, `${expected.name} integrity`);
    assertPattern(coordinate["published_at"], TIMESTAMP, `${expected.name} published timestamp`);
    assertProvenance(coordinate["provenance"], expected.name, coordinate["version"]);
  });
}

function assertWorkflow(value: unknown): void {
  const workflow = record(value, "Cohort reusable workflow");
  if (!hasExactKeys(workflow, [
    "repository", "repository_id", "path", "revision", "blob_sha"
  ]) || workflow["repository"] !== "agent-teams-ai/.github" ||
    workflow["repository_id"] !== 1_316_243_981 ||
    workflow["path"] !== ".github/workflows/docs-protocol-check.yml") {
    invalid("Qualified Cohort v2 reusable workflow authority must match its exact identity.");
  }
  assertPattern(workflow["revision"], GIT_SHA, "Workflow revision");
  assertPattern(workflow["blob_sha"], GIT_SHA, "Workflow blob SHA");
}

function assertAsset(value: unknown, subject: string, caller: boolean): void {
  const asset = record(value, subject);
  const keys = caller
    ? ["package", "path", "digest", "rendered_digest"]
    : ["package", "path", "digest"];
  if (!hasExactKeys(asset, keys) || asset["package"] !== ADAPTER_PACKAGE) {
    invalid(`${subject} must match its closed adapter-package asset shape.`);
  }
  assertPath(asset["path"], `${subject} path`);
  assertPattern(asset["digest"], SHA256, `${subject} digest`);
  if (caller) {assertPattern(asset["rendered_digest"], SHA256, `${subject} rendered digest`);}
}

function assertAssets(value: unknown): void {
  const assets = record(value, "Cohort assets");
  if (!hasExactKeys(assets, [
    "skill", "caller_workflow", "asset_catalog", "transition_catalog"
  ])) {invalid("Qualified Cohort v2 assets must match the closed four-entry shape.");}
  assertAsset(assets["skill"], "Cohort Skill asset", false);
  assertAsset(assets["caller_workflow"], "Cohort caller workflow asset", true);
  assertAsset(assets["asset_catalog"], "Cohort asset catalog", false);
  assertAsset(assets["transition_catalog"], "Cohort transition catalog", false);
}

function assertRuntime(value: unknown): void {
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

function assertRuntimeClosure(value: unknown): void {
  const closure = record(value, "Cohort runtime closure");
  if (!hasExactKeys(closure, [
    "schema_version", "domain", "package_manager", "lockfile_version", "package_count",
    "projection_path", "digest"
  ]) || closure["schema_version"] !== 2 ||
    closure["domain"] !== "agent-teams.docs-runtime-closure/v2" ||
    closure["package_manager"] !== "pnpm@11.20.0" || closure["lockfile_version"] !== "9.0" ||
    !Number.isSafeInteger(closure["package_count"]) || Number(closure["package_count"]) < 5 ||
    Number(closure["package_count"]) > 2048) {
    invalid("Qualified Cohort v2 runtime closure must match the closed current contract.");
  }
  assertPattern(closure["digest"], SHA256, "Runtime closure digest");
  if (closure["projection_path"] !== `governance/docs-runtime-closures/sha256-${
    closure["digest"].slice("sha256:".length)
  }.json`) {invalid("Qualified Cohort v2 runtime closure path must bind its digest.");}
}

function assertCanaryRepositories(value: unknown): void {
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
    assertPattern(canary["repository"], AUTHORITY_REPOSITORY, "Canary repository");
  });
}

function assertSchemasAndEdges(source: Record<string, unknown>): void {
  const schemas = record(source["schemas"], "Cohort schemas");
  const edges = array(source["dependency_edges"], "Cohort dependency edges");
  if (!hasExactKeys(schemas, Object.keys(V2_SCHEMA)) ||
    Object.entries(V2_SCHEMA).some(([key, value]) => schemas[key] !== value)) {
    invalid("Qualified Cohort v2 schemas must match the exact authority shape.");
  }
  if (edges.length !== V2_DEPENDENCY_EDGES.length || edges.some((value, index) => {
    const edge = record(value, "Cohort dependency edge");
    return !hasExactKeys(edge, ["from", "to"]) ||
      edge["from"] !== V2_DEPENDENCY_EDGES[index]?.[0] ||
      edge["to"] !== V2_DEPENDENCY_EDGES[index]?.[1];
  })) {invalid("Qualified Cohort v2 dependency edges must match the canonical package graph.");}
}

/** Validates every nested field admitted from the current raw Cohort v2 authority. */
export function assertCohortAuthorityV2(source: Record<string, unknown>): void {
  assertSchemasAndEdges(source);
  assertPackages(source);
  assertWorkflow(source["reusable_workflow"]);
  assertAssets(source["assets"]);
  assertRuntime(source["runtime"]);
  assertRuntimeClosure(source["runtime_closure"]);
  assertCanaryRepositories(source["canary_repositories"]);
  assertReferences(source["evidence_references"], "Cohort evidence references");
  if (array(source["upgrade_from"], "Cohort upgrade origins").length < 1) {
    invalid("Qualified Cohort v2 must name at least one upgrade origin.");
  }
  assertDigest(source, "record_digest", "agent-teams.docs-qualified-cohort/v2");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  const object = record(value, "Cohort canonical JSON");
  return `{${Object.keys(object).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  ).join(",")}}`;
}

function assertDigest(value: Record<string, unknown>, key: string, domain: string): void {
  const body = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  const expected = `sha256:${createHash("sha256").update(canonicalJson({ domain, body })).digest("hex")}`;
  if (value[key] !== expected) {invalid(`Cohort ${key} does not bind its canonical body.`);}
}

function assertCanaryBindings(
  event: Record<string, unknown>, source: Record<string, unknown>, qualifiedDigest: unknown
): void {
  const declared = array(source["canary_repositories"], "Declared canaries")
    .map((entry) => record(entry, "Declared canary"));
  const evidence = array(event["canary_evidence"], "Canary evidence")
    .map((entry) => record(entry, "Canary evidence"));
  const ids = declared.map((entry) => entry["repository_id"]);
  const names = declared.map((entry) => entry["repository"]);
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length ||
    evidence.length !== declared.length ||
    new Set(evidence.map((entry) => entry["repository_id"])).size !== evidence.length) {
    invalid("CANARY evidence must cover the exact unique declared repository set.");
  }
  for (const entry of evidence) {
    const match = declared.find((candidate) => candidate["repository_id"] === entry["repository_id"]);
    if (match === undefined || match["repository"] !== entry["repository"] ||
      entry["observed_cohort_id"] !== source["cohort_id"] ||
      entry["observed_record_digest"] !== source["record_digest"] ||
      qualifiedDigest === undefined || entry["observed_event_digest"] !== qualifiedDigest) {
      invalid("CANARY evidence must bind its declared repository, Cohort, record and QUALIFIED event.");
    }
  }
}

/** Global chain integrity precedes selection; only selected v2 evidence is authorized here. */
export function assertCohortEventChainV2(
  values: readonly unknown[], source: Record<string, unknown>
): void {
  let previousDigest: unknown = null;
  let qualifiedDigest: unknown;
  for (const [index, value] of values.entries()) {
    const event = record(value, "Cohort lifecycle event");
    if (event["sequence"] !== index + 1 || event["previous_event_digest"] !== previousDigest) {
      invalid("Cohort event sequence and predecessor must form one contiguous global chain.");
    }
    assertDigest(event, "event_digest", "agent-teams.docs-qualified-cohort-event/v1");
    previousDigest = event["event_digest"];
    if (event["cohort_id"] !== source["cohort_id"]) {continue;}
    assertLifecycleEventV2(event);
    if (event["state"] === "QUALIFIED") {qualifiedDigest = event["event_digest"];}
    if (event["state"] === "CANARY") {assertCanaryBindings(event, source, qualifiedDigest);}
  }
}

function assertCanaryEvidence(value: unknown): void {
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
    ["repository_id", "repository ID"], ["integration_id", "integration ID"],
    ["check_run_id", "check run ID"], ["workflow_run_id", "workflow run ID"],
    ["workflow_id", "workflow ID"]
  ] as const) {assertPositiveInteger(evidence[key], `Canary evidence ${subject}`);}
  assertPattern(evidence["repository"], AUTHORITY_REPOSITORY, "Canary evidence repository");
  assertPattern(evidence["merge_revision"], GIT_SHA, "Canary evidence merge revision");
  assertPattern(evidence["observed_record_digest"], SHA256, "Observed record digest");
  assertPattern(evidence["observed_event_digest"], SHA256, "Observed event digest");
  assertPattern(evidence["caller_workflow_digest"], SHA256, "Caller workflow digest");
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

/** Validates selected lifecycle state before it can authorize a Cohort v2 projection. */
function assertLifecycleEventV2(event: Record<string, unknown>): void {
  if (!hasExactKeys(event, [
    "sequence", "cohort_id", "state", "effective_at", "support_until",
    "evidence_references", "canary_evidence", "previous_event_digest", "event_digest"
  ]) || !LIFECYCLE_STATES.has(event["state"] as string)) {
    invalid("Qualified Cohort v2 lifecycle events must match the closed current shape.");
  }
  assertPositiveInteger(event["sequence"], "Cohort lifecycle sequence");
  assertPattern(event["effective_at"], TIMESTAMP, "Cohort lifecycle effective timestamp");
  assertPattern(event["event_digest"], SHA256, "Cohort lifecycle event digest");
  if (event["previous_event_digest"] !== null) {
    assertPattern(event["previous_event_digest"], SHA256, "Previous lifecycle event digest");
  }
  assertReferences(event["evidence_references"], "Cohort lifecycle evidence references");
  const canaryEvidence = array(event["canary_evidence"], "Cohort canary evidence");
  if (canaryEvidence.length > 32 ||
    (event["state"] === "CANARY" ? canaryEvidence.length < 1 : canaryEvidence.length !== 0)) {
    invalid("Cohort lifecycle canary evidence does not match its state.");
  }
  canaryEvidence.forEach(assertCanaryEvidence);
  if (event["state"] === "SUPERSEDED") {
    assertPattern(event["support_until"], TIMESTAMP, "Cohort lifecycle support timestamp");
  } else if (event["support_until"] !== null) {
    invalid("Only a SUPERSEDED Cohort lifecycle event may set support_until.");
  }
}
