import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { gitSha, packageReferenceCohort, parentHarness, sourceCohort } from "./configuration.ts";
import { AdoptionEvidence, assertCurrentAuthority, invoke } from "./evidence.ts";
import { bytes, json, list, selected, text } from "./files.ts";
import type { SourceAdmission } from "./admission.ts";

export const repairedReceiptBlob = "15090b6ce1ca77f3591f3337137d564b4c82dc87";
export const repairedReceiptPath = "scripts/verify-docs-cohort-v2-receipt.mjs";
export const controllerInputNames = [
  "controller-package.json",
  "controller-package-lock.json",
  "controller-archive-integrity.json",
  "installed-repository-mutation-inventory.json",
  "installed-document-authoring-inventory.json",
  "installed-docs-protocol-inventory.json",
  "installed-docs-protocol-agent-teams-inventory.json",
] as const;
export interface QualifiedTarget {
  readonly record: Row;
  readonly projection: Row;
  readonly binding: Row;
  readonly coordinates: readonly Row[];
  readonly candidatePath: string;
  readonly workflowRevision: string;
}
export function assertRepairedWorkflow(
  binding: Row,
  observed: {
    readonly workflowBlob: string;
    readonly atWorkflow: string;
    readonly atAuthority: string;
  },
): string {
  assert.equal(binding["repository"], "agent-teams-ai/.github");
  assert.equal(binding["repository_id"], 1316243981);
  assert.equal(binding["path"], ".github/workflows/docs-protocol-check.yml");
  const revision = gitSha(binding["revision"], "Cohort implementation revision");
  assert.equal(binding["blob_sha"], observed.workflowBlob);
  assert.equal(
    observed.atWorkflow,
    repairedReceiptBlob,
    "Cohort implementation lacks exact reviewed receipt repair",
  );
  assert.equal(
    observed.atAuthority,
    repairedReceiptBlob,
    "Current authority lacks exact reviewed receipt repair",
  );
  return revision;
}
export function freezeControllerInputs(evidence: AdoptionEvidence): void {
  const entries: Row[] = [];
  for (const [index, name] of controllerInputNames.entries()) {
    const path = "tools/ef70-managed-campaign/fixtures/" + name;
    const expected = evidence.git(evidence.config.harness, "retained-input-base-" + index, [
      "rev-parse",
      parentHarness + ":" + path,
    ]);
    const actual = evidence.git(evidence.config.harness, "retained-input-current-" + index, [
      "rev-parse",
      "HEAD:" + path,
    ]);
    assert.equal(actual, expected, "Authenticated controller input changed");
    entries.push({
      relativePath: path,
      blob: actual,
      ...selected(join(evidence.config.harness, path)),
    });
  }
  evidence.record("immutable-controller-inputs", entries);
}
function exactMCoordinates(record: Row, reference: Row): void {
  assert.equal(
    reference["record_digest"],
    "sha256:978a8113172e41d6960a577b8e567cea40c469a02cfae750ad754b1cfdfeed68",
  );
  for (const key of [
    "packages",
    "dependency_edges",
    "runtime",
    "policy_identity",
    "schemas",
    "runtime_closure",
    "upgrade_from",
    "rollback_to",
  ]) {
    assert.deepEqual(
      record[key],
      reference[key],
      "New cohort changes the M-specific contract: " + key,
    );
  }
  assert.equal(record["cohort_generation"], 3);
  assert.equal(record["channel"], "stable");
  assert.deepEqual(record["canary_repositories"], [
    { repository_id: 1333298097, repository: "agent-teams-ai/extension-foundation" },
  ]);
  assert.deepEqual(record["upgrade_from"], [sourceCohort]);
  assert.deepEqual(record["rollback_to"], [sourceCohort]);
}
function uniqueRecord(registry: Row, cohort: string): Row {
  const matches = list(registry["cohorts"], "Qualified records")
    .map((value) => row(value, "record"))
    .filter((record) => record["cohort_id"] === cohort);
  assert.equal(matches.length, 1);
  return matches[0]!;
}
function withoutLifecycle(projection: Row): Row {
  return Object.fromEntries(
    Object.entries(projection).filter(
      ([key]) => key !== "lifecycleState" && key !== "canaryRepositoryIds",
    ),
  );
}
function selectQualifiedRecord(
  evidence: AdoptionEvidence,
  owner: Row,
  registry: Row,
): QualifiedTarget {
  const c = evidence.config;
  const record = uniqueRecord(registry, c.targetCohort);
  exactMCoordinates(record, uniqueRecord(registry, packageReferenceCohort));
  const candidatePath = join(
    c.central,
    "governance/evidence/docs-cohorts",
    c.targetCohort,
    "candidate-input.json",
  );
  const candidate = json(candidatePath);
  assert.equal(candidate["qualified"], false, "Raw candidate is not a qualification result");
  assert.equal(record["candidate_digest"], selected(candidatePath).sha256);
  const proposed = row(candidate["proposedRecord"], "Actual candidate proposal");
  for (const [key, value] of Object.entries(proposed)) {
    assert.deepEqual(record[key], value, "Registered immutable candidate field differs: " + key);
  }
  const projection = row(
    invoke(owner, "qualifiedCohortProjection", [registry, c.targetCohort]),
    "Qualified projection",
  );
  assert.equal(projection["schemaVersion"], 3);
  assert(
    ["QUALIFIED", "CANARY", "RECOMMENDED"].includes(
      text(projection["lifecycleState"], "Lifecycle"),
    ),
  );
  assert.deepEqual(projection["canaryRepositoryIds"], ["1333298097"]);
  assert.equal(
    invoke(owner, "isDocsCohortSelectableForRepository", [
      record,
      projection["lifecycleState"],
      1333298097,
    ]),
    true,
  );
  const workflow = row(record["reusable_workflow"], "Actual immutable workflow");
  const revision = gitSha(workflow["revision"], "Workflow revision");
  const workflowRevision = assertRepairedWorkflow(workflow, {
    workflowBlob: evidence.git(c.central, "selected-workflow-blob", [
      "rev-parse",
      revision + ":.github/workflows/docs-protocol-check.yml",
    ]),
    atWorkflow: evidence.git(c.central, "selected-receipt-repair", [
      "rev-parse",
      revision + ":" + repairedReceiptPath,
    ]),
    atAuthority: evidence.git(c.central, "authority-receipt-repair", [
      "rev-parse",
      c.authorityRevision + ":" + repairedReceiptPath,
    ]),
  });
  evidence.git(c.central, "selected-implementation-ancestry", [
    "merge-base",
    "--is-ancestor",
    workflowRevision,
    c.authorityRevision,
  ]);
  evidence.retain("candidate-input.json", bytes(candidatePath));
  evidence.record("qualified-projection", projection);
  evidence.record("selected-repaired-implementation", {
    workflow,
    workflowRevision,
    repairedReceiptBlob,
    authorityRevision: c.authorityRevision,
    scope: "Exact reviewed runtime repair; not a substituted old cohort or caller.",
  });
  return {
    record,
    projection,
    binding: withoutLifecycle(projection),
    candidatePath,
    workflowRevision,
    coordinates: list(record["packages"], "Actual package census").map((value) =>
      row(value, "coordinate"),
    ),
  };
}
export async function admitAuthority(
  evidence: AdoptionEvidence,
  source: SourceAdmission,
): Promise<QualifiedTarget> {
  await assertCurrentAuthority(evidence, "authority-before-admission");
  const c = evidence.config;
  assert.equal(
    evidence.git(c.central, "authority-current-clean", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    "",
  );
  const registryPath = join(c.central, "governance/docs-qualified-cohorts.json");
  const registry = json(registryPath),
    registrySelection = selected(registryPath);
  const owner = row(
    await import(pathToFileURL(join(c.central, "scripts/docs-cohort-policy.mjs")).href),
    "Actual Central owner",
  );
  invoke(owner, "validateDocsQualifiedCohorts", [
    registry,
    json(join(c.central, "governance/docs-qualified-cohorts.schema.json")),
  ]);
  const origin = row(
    invoke(owner, "qualifiedCohortProjection", [registry, sourceCohort]),
    "Actual original binding",
  );
  assert.deepEqual(
    withoutLifecycle(origin),
    source.profile["cohort"],
    "Source profile must retain actual immutable stable31 binding",
  );
  const selectedTarget = selectQualifiedRecord(evidence, owner, registry);
  assert.deepEqual(selected(registryPath), registrySelection);
  evidence.record("registry-selection", registrySelection);
  await assertCurrentAuthority(evidence, "authority-after-admission");
  return selectedTarget;
}
