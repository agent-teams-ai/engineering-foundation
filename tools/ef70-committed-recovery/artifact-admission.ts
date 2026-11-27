import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { validatePreflight as validateAdoptionPreflight } from "../ef70-managed-adoption/admission.ts";
import { AdoptionEvidence, invoke } from "../ef70-managed-adoption/evidence.ts";
import { list, text } from "../ef70-managed-adoption/files.ts";
import {
  adoptionHarness,
  consumerBranch,
  positiveId,
  type ArtifactSelection,
  type RecoveryConfig,
} from "./configuration.ts";
import type { OriginalArchive } from "./artifact-intake.ts";

export const recoveryPreflightSteps = [
  "Install the ordinary producer profile",
  "Build current producer source with its admitted compiler",
  "Run explicit Stack cleanup and require unchanged source",
  "Provision the unchanged frozen managed test tools",
  "Check the complete actual committed delta",
  "Run the unchanged required fast route",
  "Qualify workflow security",
  "Check canonical adoption admission and failure contracts",
  "Check committed recovery admission and intake contracts",
] as const;
function repository(run: Row, id: number, name: string): void {
  for (const key of ["repository", "head_repository"]) {
    const repo = row(run[key], key);
    assert.equal(repo["id"], id);
    assert.equal(repo["full_name"], "agent-teams-ai/" + name);
  }
}
function successfulJob(response: Row, name: string, head: string, steps: readonly string[]): Row {
  const jobs = list(response["jobs"], "Complete actual jobs").map((value) => row(value, "Job"));
  assert.equal(response["total_count"], jobs.length);
  assert(jobs.length > 0 && jobs.length <= 20);
  const matching = jobs.filter(
    (job) => job["name"] === name || String(job["name"]).endsWith(" / " + name),
  );
  assert.equal(matching.length, 1, "Unique actual successful job");
  const job = matching[0]!;
  assert.equal(job["status"], "completed");
  assert.equal(job["conclusion"], "success");
  assert.equal(job["head_sha"], head);
  const actual = list(job["steps"], "Actual job steps").map((value) => row(value, "Step"));
  for (const stepName of steps) {
    const matches = actual.filter((step) => step["name"] === stepName);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!["status"], "completed");
    assert.equal(matches[0]!["conclusion"], "success");
  }
  return job;
}
export function validateRecoveryPreflight(
  run: Row,
  jobs: Row,
  config: Pick<RecoveryConfig, "preflightRunId" | "harnessRevision">,
): Row {
  assert.equal(String(run["id"]), config.preflightRunId);
  assert.equal(run["run_attempt"], 1);
  assert.equal(run["status"], "completed");
  assert.equal(run["conclusion"], "success");
  assert.equal(run["event"], "push");
  assert.equal(run["head_sha"], config.harnessRevision);
  assert.equal(run["head_branch"], "test/ef70-committed-recovery");
  assert.equal(run["path"], ".github/workflows/ef70-committed-recovery.yml");
  repository(run, 1316243988, "engineering-foundation");
  const job = successfulJob(
    jobs,
    "ef70-recovery-preflight",
    config.harnessRevision,
    recoveryPreflightSteps,
  );
  return {
    runId: config.preflightRunId,
    attempt: 1,
    head: config.harnessRevision,
    jobId: job["id"],
    scope: "Source feedback only; not trusted consumer qualification.",
  };
}
export function validateOriginalRun(
  run: Row,
  jobs: Row,
  artifact: Row,
  selection: ArtifactSelection,
  marker: Row,
): Row {
  assert.equal(String(run["id"]), selection.runId);
  assert.equal(run["run_attempt"], Number(selection.attempt));
  assert.equal(run["status"], "completed");
  assert.equal(run["conclusion"], "success");
  assert.equal(run["event"], "push");
  assert.equal(run["head_branch"], consumerBranch);
  assert.equal(run["head_sha"], marker["sourceRevision"]);
  assert.equal(run["path"], ".github/workflows/ef70-managed-campaign.yml");
  repository(run, 1333298097, "extension-foundation");
  const referenced = list(run["referenced_workflows"], "Actual reusable workflow binding").map(
    (value) => row(value, "Workflow"),
  );
  const matches = referenced.filter((workflow) =>
    String(workflow["path"]).startsWith(
      "agent-teams-ai/engineering-foundation/.github/workflows/ef70-canonical-adoption.yml@",
    ),
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!["sha"], adoptionHarness);
  const job = successfulJob(jobs, "ef70-canonical-adoption", String(marker["sourceRevision"]), [
    "Install the exact producer harness dependencies",
    "Authenticate and execute the canonical public transition",
    "Emit bounded actual evidence for read-only observation",
    "Retain actual diagnostics and canonical adoption evidence",
  ]);
  assert.equal(String(artifact["id"]), selection.artifactId);
  assert.equal(artifact["expired"], false);
  assert.equal(artifact["digest"], selection.artifactDigest);
  assert.equal(
    artifact["name"],
    "ef70-canonical-adoption-" +
      String(marker["sourceRevision"]) +
      "-" +
      selection.runId +
      "-" +
      selection.attempt,
  );
  const origin = row(artifact["workflow_run"], "Artifact run binding");
  assert.equal(String(origin["id"]), selection.runId);
  assert.equal(origin["head_sha"], marker["sourceRevision"]);
  assert.equal(origin["repository_id"], 1333298097);
  assert.equal(origin["head_repository_id"], 1333298097);
  assert.equal(origin["head_branch"], consumerBranch);
  assert.equal(marker["schemaVersion"], 1);
  assert.equal(marker["evidenceClass"], "actual-published-canonical-adoption");
  assert.equal(marker["outcome"], "prepare-finalize-installed-check-complete");
  assert.equal(marker["harnessRevision"], adoptionHarness);
  assert.equal(String(marker["hostRunId"]), selection.runId);
  assert.equal(String(marker["hostRunAttempt"]), selection.attempt);
  assert.equal(
    row(marker["preparation"], "Original preparation selection")["sha256"],
    selection.preparationDigest,
  );
  return {
    jobId: job["id"],
    runId: selection.runId,
    attempt: selection.attempt,
    artifactId: selection.artifactId,
    artifactDigest: selection.artifactDigest,
  };
}
export async function admitOriginalArtifact(
  evidence: AdoptionEvidence,
  config: RecoveryConfig,
  archive: OriginalArchive,
): Promise<Row> {
  const preflight = await evidence.github(
    "engineering-foundation/actions/runs/" + config.preflightRunId,
    "recovery-preflight-run",
  );
  const preflightJobs = await evidence.github(
    "engineering-foundation/actions/runs/" +
      config.preflightRunId +
      "/attempts/1/jobs?per_page=100",
    "recovery-preflight-jobs",
  );
  const selected = validateRecoveryPreflight(preflight, preflightJobs, config);
  evidence.record("recovery-preflight-verified", selected);
  const a = config.artifact;
  const run = await evidence.github(
    "extension-foundation/actions/runs/" + a.runId + "/attempts/" + a.attempt,
    "original-adoption-run",
  );
  const jobs = await evidence.github(
    "extension-foundation/actions/runs/" +
      a.runId +
      "/attempts/" +
      a.attempt +
      "/jobs?per_page=100",
    "original-adoption-jobs",
  );
  const artifact = await evidence.github(
    "extension-foundation/actions/artifacts/" + a.artifactId,
    "original-adoption-artifact",
  );
  assert.equal(artifact["size_in_bytes"], archive.archive["bytes"]);
  const original = validateOriginalRun(run, jobs, artifact, a, archive.marker);
  const originalPreflight = row(
    archive.bootstrap["producerPreflight"],
    "Original actual H2 preflight",
  );
  const runId = positiveId(String(originalPreflight["runId"]), "H2 preflight id");
  const h2Run = await evidence.github(
    "engineering-foundation/actions/runs/" + runId,
    "original-h2-preflight-run",
  );
  const h2Jobs = await evidence.github(
    "engineering-foundation/actions/runs/" + runId + "/attempts/1/jobs?per_page=100",
    "original-h2-preflight-jobs",
  );
  assert.deepEqual(
    validateAdoptionPreflight(h2Run, h2Jobs, { runId, harnessRevision: adoptionHarness }),
    originalPreflight,
  );
  assert.equal(archive.bootstrap["harnessRevision"], adoptionHarness);
  const originalTree = evidence.git(evidence.config.harness, "original-h2-source-tree", [
    "rev-parse",
    adoptionHarness + "^{tree}",
  ]);
  assert.equal(archive.marker["harnessTree"], originalTree);
  assert.equal(archive.bootstrap["harnessTree"], originalTree);
  assert.equal(archive.bootstrap["sourceRevision"], archive.marker["sourceRevision"]);
  assert.equal(archive.bootstrap["sourceTree"], archive.marker["sourceTree"]);
  assert.equal(archive.bootstrap["targetCohort"], config.targetCohort);
  evidence.record("original-artifact-admitted", {
    ...original,
    originalPreflight,
    actualZip: archive.archive,
    currentAuthority: config.authorityRevision,
  });
  return selected;
}
export async function assertCurrentPR(evidence: AdoptionEvidence, label: string): Promise<void> {
  const pr = await evidence.github("extension-foundation/pulls/70", label);
  assert.equal(pr["state"], "open");
  assert.equal(pr["merged"], false);
  const head = row(pr["head"], "Current PR70 head");
  assert.equal(head["ref"], consumerBranch);
  assert.equal(
    head["sha"],
    evidence.config.sourceRevision,
    "Current final F moved; qualify the real new push",
  );
  assert.equal(row(head["repo"], "PR70 head repository")["id"], 1333298097);
  assert.equal(text(row(pr["base"], "PR70 base")["ref"], "Base"), "main");
}
export function assertCaller(
  value: unknown,
  revision: string,
  fields: Row,
  current: boolean,
): void {
  const caller = row(value, "Actual committed caller YAML");
  const trigger = row(row(caller["on"], "Caller events")["push"], "Caller push");
  assert.deepEqual(trigger["branches"], [consumerBranch]);
  if (current) {
    assert.equal(trigger["paths"], undefined, "Every genuine final F push must select itself");
    assert.equal(trigger["paths-ignore"], undefined);
    assert.deepEqual(Object.keys(row(caller["on"], "Caller events")), ["push"]);
  }
  const jobs = Object.values(row(caller["jobs"], "Caller jobs"));
  assert.equal(jobs.length, 1, "One finite validation caller job");
  const job = row(jobs[0], "Selected reusable caller");
  assert.equal(
    job["uses"],
    "agent-teams-ai/engineering-foundation/.github/workflows/" +
      (current ? "ef70-committed-recovery.yml" : "ef70-canonical-adoption.yml") +
      "@" +
      revision,
  );
  const inputs = row(job["with"], "Actual selected caller inputs");
  assert.deepEqual(Object.keys(inputs).toSorted(), Object.keys(fields).toSorted());
  for (const [name, expected] of Object.entries(fields)) {
    const observed = inputs[name];
    assert(
      typeof observed === "string" ||
        (typeof observed === "number" && Number.isSafeInteger(observed)),
    );
    assert.equal(String(observed), String(expected), "Committed caller input changed: " + name);
  }
}
export async function assertCallerBindings(
  evidence: AdoptionEvidence,
  config: RecoveryConfig,
  archive: OriginalArchive,
): Promise<void> {
  const yamlPath = createRequire(join(config.harness, "package.json")).resolve("yaml");
  const yaml = row(await import(pathToFileURL(yamlPath).href), "Installed qualified YAML library");
  const originalRevision = text(archive.marker["sourceRevision"], "Original C");
  const originalPreflight = row(
    archive.bootstrap["producerPreflight"],
    "Actual original preflight",
  );
  assert.equal(archive.bootstrap["authorityRevision"], archive.marker["authorityRevision"]);
  const expected = [
    {
      revision: originalRevision,
      harness: adoptionHarness,
      current: false,
      label: "original-c-caller",
      fields: {
        harness_revision: adoptionHarness,
        preflight_run_id: originalPreflight["runId"],
        authority_revision: archive.marker["authorityRevision"],
        target_cohort: archive.marker["targetCohort"],
      },
    },
    {
      revision: config.sourceRevision,
      harness: config.harnessRevision,
      current: true,
      label: "current-f-caller",
      fields: {
        harness_revision: config.harnessRevision,
        preflight_run_id: config.preflightRunId,
        authority_revision: config.authorityRevision,
        adoption_run_id: config.artifact.runId,
        adoption_run_attempt: config.artifact.attempt,
        adoption_artifact_id: config.artifact.artifactId,
        adoption_artifact_digest: config.artifact.artifactDigest,
        preparation_digest: config.artifact.preparationDigest,
      },
    },
  ];
  for (const selected of expected) {
    const source = evidence.git(config.consumer, selected.label, [
      "show",
      selected.revision + ":.github/workflows/ef70-managed-campaign.yml",
    ]);
    assert(Buffer.byteLength(source) <= 128 * 1024);
    const parsed = invoke(yaml, "parse", [source, { uniqueKeys: true, maxAliasCount: 0 }]);
    assertCaller(parsed, selected.harness, selected.fields, selected.current);
    evidence.record(selected.label + "-verified", {
      revision: selected.revision,
      harnessRevision: selected.harness,
      inputs: selected.fields,
      scope:
        "Actual committed caller selects the exact reusable implementation and checkout/preflight inputs.",
    });
  }
}
