import type {
  ConsumerIntegrationDesiredStateV1,
  QualifiedDocsCohortBindingV1
} from "../../domain/model.js";

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

function hasUniqueEntries(entries: readonly string[]): boolean {
  return new Set(entries).size === entries.length;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

function hasValidGovernedRoots(roots: readonly string[] | undefined): boolean {
  return roots === undefined || (roots.length > 0 && roots.length <= 32 &&
    hasUniqueEntries(roots) && roots.every((root) => REPOSITORY_PATH.test(root)));
}

function isCanonicalUtcSeconds(value: string): boolean {
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
    const prototype = Object.getPrototypeOf(candidate);
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

function hasValidCohortAuthority(cohort: QualifiedDocsCohortBindingV1): boolean {
  return COHORT_ID.test(cohort.cohortId) &&
    NONZERO_SHA256.test(cohort.recordDigest) &&
    NONZERO_SHA256.test(cohort.qualificationEventDigest) &&
    isCanonicalUtcSeconds(cohort.eligibleAfter) &&
    hasUniqueEntries(cohort.upgradeFrom) &&
    hasUniqueEntries(cohort.rollbackTo) &&
    cohort.upgradeFrom.every((entry) => COHORT_ID.test(entry)) &&
    cohort.rollbackTo.every((entry) => COHORT_ID.test(entry));
}

function hasValidPackages(cohort: QualifiedDocsCohortBindingV1): boolean {
  const packages = cohort.packages;
  return SEMVER.test(packages.docsProtocol.version) &&
    SEMVER.test(packages.engineeringFoundation.version) &&
    INTEGRITY.test(packages.docsProtocol.integrity) &&
    INTEGRITY.test(packages.engineeringFoundation.integrity);
}

function hasValidWorkflow(cohort: QualifiedDocsCohortBindingV1): boolean {
  const workflow = cohort.workflow;
  return workflow.repository === WORKFLOW_REPOSITORY &&
    workflow.path === WORKFLOW_PATH &&
    NONZERO_SHA.test(workflow.revision) &&
    NONZERO_SHA.test(workflow.blobSha);
}

export function assertQualifiedDocsCohortBindingV1(
  cohort: QualifiedDocsCohortBindingV1
): void {
  assertPlainBoundedJson(cohort);
  const valid = hasExactKeys(cohort, [
    "schemaVersion", "cohortId", "channel", "recordDigest", "qualificationEventDigest",
    "eligibleAfter", "upgradeFrom", "rollbackTo", "packages", "workflow", "assets",
    "schemas", "runtime"
  ]) &&
    hasExactKeys(cohort.packages, ["docsProtocol", "engineeringFoundation"]) &&
    hasExactKeys(cohort.packages.docsProtocol, ["version", "integrity"]) &&
    hasExactKeys(cohort.packages.engineeringFoundation, ["version", "integrity"]) &&
    hasExactKeys(cohort.workflow, ["repository", "path", "revision", "blobSha"]) &&
    hasExactKeys(cohort.assets, [
      "skillDigest", "callerWorkflowDigest", "assetCatalogDigest", "transitionCatalogDigest"
    ]) &&
    hasExactKeys(cohort.schemas, [
      "consumerIntegration", "managedState", "docsProtocol"
    ]) &&
    hasExactKeys(cohort.runtime, ["node", "pnpm", "runtimeClosureDigest"]) &&
    cohort.schemaVersion === 1 &&
    hasValidCohortAuthority(cohort) &&
    hasValidPackages(cohort) &&
    hasValidWorkflow(cohort) &&
    NONZERO_SHA256.test(cohort.assets.skillDigest) &&
    NONZERO_SHA256.test(cohort.assets.callerWorkflowDigest) &&
    NONZERO_SHA256.test(cohort.assets.assetCatalogDigest) &&
    NONZERO_SHA256.test(cohort.assets.transitionCatalogDigest) &&
    cohort.runtime.node === ">=24.18.0 <25" &&
    cohort.runtime.pnpm === ">=11.17.0 <12" &&
    NONZERO_SHA256.test(cohort.runtime.runtimeClosureDigest);
  if (!valid) {
    throw new TypeError("Qualified Docs Cohort binding is invalid or unsupported.");
  }
}

export function assertConsumerIntegrationDesiredStateV1(
  desired: ConsumerIntegrationDesiredStateV1
): void {
  assertPlainBoundedJson(desired);
  assertQualifiedDocsCohortBindingV1(desired.cohort);
  const valid = hasExactKeys(desired, [
    "schemaVersion", "repository", "integrationRoot", "packageManager", "profilePath",
    "skillPath", "callerWorkflowPath", "managedStatePath", "cohort",
    ...(desired.governedDocsRoots === undefined ? [] : ["governedDocsRoots"])
  ]) &&
    hasExactKeys(desired.repository, ["provider", "id", "nameWithOwner"]) &&
    desired.schemaVersion === 1 &&
    desired.integrationRoot === "." &&
    desired.packageManager === "pnpm" &&
    desired.profilePath === PROFILE_PATH &&
    desired.skillPath === SKILL_PATH &&
    desired.callerWorkflowPath === CALLER_WORKFLOW_PATH &&
    desired.managedStatePath === MANAGED_STATE_PATH &&
    desired.repository.provider === "github" &&
    REPOSITORY_ID.test(desired.repository.id) &&
    REPOSITORY.test(desired.repository.nameWithOwner) &&
    hasValidGovernedRoots(desired.governedDocsRoots) &&
    desired.cohort.schemaVersion === 1;
  if (!valid) {
    throw new TypeError("Consumer integration desired state is invalid or unsupported.");
  }
}
