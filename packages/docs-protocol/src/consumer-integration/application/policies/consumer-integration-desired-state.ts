import type { ConsumerIntegrationDesiredStateV1 } from "../../domain/model.js";

const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const NONZERO_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const NONZERO_SHA256 = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REPOSITORY_ID = /^[1-9][0-9]*$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

const PROFILE_PATH = "architecture/foundation/docs-protocol.yaml";
const SKILL_PATH = ".agents/skills/docs-authoring/SKILL.md";
const CALLER_WORKFLOW_PATH = ".github/workflows/docs-protocol.yml";
const MANAGED_STATE_PATH = "architecture/foundation/docs-protocol-managed-state.json";
const WORKFLOW_REPOSITORY = "agent-teams-ai/.github";
const WORKFLOW_PATH = ".github/workflows/docs-protocol-check.yml";

function hasUniqueEntries(entries: readonly string[]): boolean {
  return new Set(entries).size === entries.length;
}

function isCanonicalUtcSeconds(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().replace(".000", "") === value;
}

function hasValidCohortAuthority(desired: ConsumerIntegrationDesiredStateV1): boolean {
  const cohort = desired.cohort;
  return COHORT_ID.test(cohort.cohortId) &&
    NONZERO_SHA256.test(cohort.recordDigest) &&
    NONZERO_SHA256.test(cohort.qualificationEventDigest) &&
    ["QUALIFIED", "CANARY", "RECOMMENDED"].includes(cohort.lifecycleState) &&
    isCanonicalUtcSeconds(cohort.eligibleAfter) &&
    hasUniqueEntries(cohort.upgradeFrom) &&
    hasUniqueEntries(cohort.rollbackTo) &&
    hasUniqueEntries(cohort.canaryRepositoryIds) &&
    cohort.upgradeFrom.every((entry) => COHORT_ID.test(entry)) &&
    cohort.rollbackTo.every((entry) => COHORT_ID.test(entry)) &&
    cohort.canaryRepositoryIds.length > 0 &&
    cohort.canaryRepositoryIds.every((entry) => REPOSITORY_ID.test(entry));
}

function hasValidPackages(desired: ConsumerIntegrationDesiredStateV1): boolean {
  const packages = desired.cohort.packages;
  return SEMVER.test(packages.docsProtocol.version) &&
    SEMVER.test(packages.engineeringFoundation.version) &&
    INTEGRITY.test(packages.docsProtocol.integrity) &&
    INTEGRITY.test(packages.engineeringFoundation.integrity);
}

function hasValidWorkflow(desired: ConsumerIntegrationDesiredStateV1): boolean {
  const workflow = desired.cohort.workflow;
  return workflow.repository === WORKFLOW_REPOSITORY &&
    workflow.path === WORKFLOW_PATH &&
    NONZERO_SHA.test(workflow.revision) &&
    NONZERO_SHA.test(workflow.blobSha);
}

export function assertConsumerIntegrationDesiredStateV1(
  desired: ConsumerIntegrationDesiredStateV1
): void {
  const valid = desired.schemaVersion === 1 &&
    desired.integrationRoot === "." &&
    desired.packageManager === "pnpm" &&
    desired.profilePath === PROFILE_PATH &&
    desired.skillPath === SKILL_PATH &&
    desired.callerWorkflowPath === CALLER_WORKFLOW_PATH &&
    desired.managedStatePath === MANAGED_STATE_PATH &&
    desired.repository.provider === "github" &&
    REPOSITORY_ID.test(desired.repository.id) &&
    REPOSITORY.test(desired.repository.nameWithOwner) &&
    desired.cohort.schemaVersion === 1 &&
    hasValidCohortAuthority(desired) &&
    hasValidPackages(desired) &&
    hasValidWorkflow(desired) &&
    NONZERO_SHA256.test(desired.cohort.assets.skillDigest) &&
    NONZERO_SHA256.test(desired.cohort.assets.callerWorkflowDigest) &&
    NONZERO_SHA256.test(desired.cohort.assets.assetCatalogDigest);
  if (!valid) {
    throw new TypeError("Consumer integration desired state is invalid or unsupported.");
  }
}
