import type {
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationDesiredStateV1,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../../domain/model.js";
import { QUALIFIED_DOCS_COHORT_V2_PACKAGES } from "./qualified-docs-cohort-v2.js";

const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const NONZERO_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const NONZERO_SHA256 = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REPOSITORY_ID = /^[1-9][0-9]*$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const REPOSITORY_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@-]{1,255}(?:\/[A-Za-z0-9._@-]{1,255})*$/u;

const PROFILE_PATH = "architecture/foundation/docs-protocol.yaml";
const SKILL_PATH = ".agents/skills/docs-authoring/SKILL.md";
const CALLER_WORKFLOW_PATH = ".github/workflows/docs-protocol.yml";
const MANAGED_STATE_PATH = "architecture/foundation/docs-protocol-managed-state.json";
const WORKFLOW_REPOSITORY = "agent-teams-ai/.github";
const WORKFLOW_PATH = ".github/workflows/docs-protocol-check.yml";

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 2048 && Array.from(value).every((entry: unknown) => typeof entry === "string") &&
    new Set(value).size === value.length;
}

function hasValidGovernedRoots(roots: unknown): boolean {
  return roots === undefined || (stringList(roots) && roots.length > 0 && roots.length <= 32 &&
    roots.every((root) => REPOSITORY_PATH.test(root)));
}

function isCanonicalUtcSeconds(value: unknown): boolean {
  if (typeof value !== "string") {return false;}
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().replace(".000", "") === value;
}

function assertPlainBoundedJson(value: unknown): void {
  let remaining = 2048;
  const seen = new Set<object>();
  // oxlint-disable-next-line complexity
  const visit = (candidate: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 16) {throw new TypeError("Consumer input exceeds bounded JSON limits.");}
    if (candidate === null || typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isSafeInteger(candidate))) {return;}
    if (typeof candidate === "string") {
      if (candidate.length > 4096 || candidate.includes("\u0000")) {
        throw new TypeError("Consumer input contains an invalid or overlong string.");
      }
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) {
      throw new TypeError("Consumer input must be acyclic plain JSON data.");
    }
    seen.add(candidate);
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new TypeError("Consumer input must use plain JSON objects and arrays.");
    }
    if (Object.getOwnPropertySymbols(candidate).length > 0) {
      throw new TypeError("Consumer input must not contain symbol properties.");
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
      if (Array.isArray(candidate) && key === "length") {continue;}
      if (descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
        throw new TypeError("Consumer input must not contain accessors or hidden properties.");
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

function hasValidAuthority(cohort: Record<string, unknown>, generation: 1 | 2): boolean {
  const upgrades = cohort["upgradeFrom"];
  const rollbacks = cohort["rollbackTo"];
  if (!stringList(upgrades) || !stringList(rollbacks)) {return false;}
  return cohort["schemaVersion"] === generation &&
    (cohort["channel"] === "rc" || cohort["channel"] === "stable") &&
    matches(cohort["cohortId"], COHORT_ID) &&
    matches(cohort["recordDigest"], NONZERO_SHA256) &&
    matches(cohort["qualificationEventDigest"], NONZERO_SHA256) &&
    isCanonicalUtcSeconds(cohort["eligibleAfter"]) &&
    upgrades.every((entry) => COHORT_ID.test(entry)) &&
    rollbacks.every((entry) => COHORT_ID.test(entry)) &&
    (generation === 1 || (upgrades.length <= 32 && rollbacks.length <= 32 &&
      !upgrades.includes(cohort["cohortId"]) &&
      rollbacks.every((entry) => entry !== cohort["cohortId"] && upgrades.includes(entry))));
}

function hasValidPackages(value: unknown, keys: readonly string[]): boolean {
  return hasExactKeys(value, keys) && keys.every((key) => {
    const coordinate = value[key];
    return hasExactKeys(coordinate, ["version", "integrity"]) &&
      matches(coordinate["version"], SEMVER) && matches(coordinate["integrity"], INTEGRITY);
  });
}

function hasValidWorkflow(value: unknown): boolean {
  return hasExactKeys(value, ["repository", "path", "revision", "blobSha"]) &&
    value["repository"] === WORKFLOW_REPOSITORY && value["path"] === WORKFLOW_PATH &&
    matches(value["revision"], NONZERO_SHA) && matches(value["blobSha"], NONZERO_SHA);
}

function hasValidAssets(value: unknown): boolean {
  const keys = ["skillDigest", "callerWorkflowDigest", "assetCatalogDigest", "transitionCatalogDigest"];
  return hasExactKeys(value, keys) && keys.every((key) => matches(value[key], NONZERO_SHA256));
}

function hasValidSchemasAndRuntime(cohort: Record<string, unknown>, generation: 1 | 2): boolean {
  const schemas = cohort["schemas"];
  const runtime = cohort["runtime"];
  return hasExactKeys(schemas, ["consumerIntegration", "managedState", "docsProtocol"]) &&
    schemas["consumerIntegration"] === (generation === 1 ? 1 : 3) &&
    schemas["managedState"] === generation && schemas["docsProtocol"] === 1 &&
    hasExactKeys(runtime, ["node", "pnpm", "runtimeClosureDigest"]) &&
    runtime["node"] === ">=24.18.0 <25" && runtime["pnpm"] === ">=11.17.0 <12" &&
    matches(runtime["runtimeClosureDigest"], NONZERO_SHA256);
}

function hasValidCohort(cohort: unknown, generation: 1 | 2): boolean {
  return hasExactKeys(cohort, [
    "schemaVersion", "cohortId", "channel", "recordDigest", "qualificationEventDigest",
    "eligibleAfter", "upgradeFrom", "rollbackTo", "packages", "workflow", "assets", "schemas", "runtime"
  ]) && hasValidAuthority(cohort, generation) &&
    hasValidPackages(cohort["packages"], generation === 1
      ? ["docsProtocol", "engineeringFoundation"]
      : QUALIFIED_DOCS_COHORT_V2_PACKAGES.map(({ key }) => key)) &&
    hasValidWorkflow(cohort["workflow"]) && hasValidAssets(cohort["assets"]) &&
    hasValidSchemasAndRuntime(cohort, generation);
}

export function assertQualifiedDocsCohortBindingV1(
  cohort: unknown
): asserts cohort is QualifiedDocsCohortBindingV1 {
  assertPlainBoundedJson(cohort);
  if (!hasValidCohort(cohort, 1)) {
    throw new TypeError("Qualified Docs Cohort binding is invalid or unsupported.");
  }
}

export function assertQualifiedDocsCohortBindingV2(
  cohort: unknown
): asserts cohort is QualifiedDocsCohortBindingV2 {
  assertPlainBoundedJson(cohort);
  if (!hasValidCohort(cohort, 2)) {
    throw new TypeError("Qualified Docs Cohort v2 binding is invalid or unsupported.");
  }
}

function hasValidRepository(repository: unknown): boolean {
  return hasExactKeys(repository, ["provider", "id", "nameWithOwner"]) &&
    repository["provider"] === "github" && matches(repository["id"], REPOSITORY_ID) &&
    matches(repository["nameWithOwner"], REPOSITORY);
}

function hasValidQualification(value: unknown): boolean {
  return hasExactKeys(value, ["contractPath", "gateCommand"]) &&
    value["contractPath"] === "architecture/foundation/docs-protocol-qualification.json" &&
    value["gateCommand"] === "pnpm docs:protocol:check";
}

function hasValidDesired(desired: unknown, version: 1 | 3): boolean {
  if (typeof desired !== "object" || desired === null) {return false;}
  const roots = "governedDocsRoots" in desired ? desired.governedDocsRoots : undefined;
  if (!hasExactKeys(desired, [
    "schemaVersion", "repository", "integrationRoot", "packageManager", "profilePath",
    "skillPath", "callerWorkflowPath", "managedStatePath", "cohort",
    ...(version === 3 ? ["qualification"] : []),
    ...(roots === undefined ? [] : ["governedDocsRoots"])
  ])) {return false;}
  const qualification = desired["qualification"];
  return desired["schemaVersion"] === version && desired["integrationRoot"] === "." &&
    desired["packageManager"] === "pnpm" && desired["profilePath"] === PROFILE_PATH &&
    desired["skillPath"] === SKILL_PATH && desired["callerWorkflowPath"] === CALLER_WORKFLOW_PATH &&
    desired["managedStatePath"] === MANAGED_STATE_PATH &&
    hasValidRepository(desired["repository"]) && hasValidGovernedRoots(roots) &&
    hasValidCohort(desired["cohort"], version === 1 ? 1 : 2) &&
    (version === 1 || hasValidQualification(qualification));
}

export function assertConsumerIntegrationDesiredStateV1(
  desired: unknown
): asserts desired is ConsumerIntegrationDesiredStateV1 {
  assertPlainBoundedJson(desired);
  if (!hasValidDesired(desired, 1)) {
    throw new TypeError("Consumer integration desired state is invalid or unsupported.");
  }
}

export function assertConsumerIntegrationDesiredStateV3(
  desired: unknown
): asserts desired is ConsumerIntegrationDesiredStateV3 {
  assertPlainBoundedJson(desired);
  if (!hasValidDesired(desired, 3)) {
    throw new TypeError("Consumer integration desired state v3 is invalid or unsupported.");
  }
}
