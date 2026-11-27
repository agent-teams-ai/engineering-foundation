import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { parentHarness, sourceCohort, type AdoptionConfig } from "./configuration.ts";
import { AdoptionEvidence } from "./evidence.ts";
import {
  inventory,
  json,
  list,
  regularImage,
  rootIdentity,
  text,
  type FileImage,
} from "./files.ts";

export const preflightSteps = [
  "Install the ordinary producer profile",
  "Build current producer source with its admitted compiler",
  "Run explicit Stack cleanup and require unchanged source",
  "Provision the unchanged frozen managed test tools",
  "Check the complete actual committed delta",
  "Run the unchanged required fast route",
  "Qualify workflow security",
  "Check canonical adoption admission and failure contracts",
] as const;
export function validatePreflight(
  run: Row,
  response: Row,
  selection: {
    readonly runId: string;
    readonly harnessRevision: string;
  },
): Row {
  assert.equal(String(run["id"]), selection.runId);
  assert.equal(run["run_attempt"], 1);
  assert.equal(run["status"], "completed");
  assert.equal(run["conclusion"], "success");
  assert.equal(run["event"], "push");
  assert.equal(run["head_sha"], selection.harnessRevision);
  assert.equal(run["head_branch"], "test/ef70-canonical-adoption");
  assert.equal(run["path"], ".github/workflows/ef70-canonical-adoption.yml");
  for (const key of ["repository", "head_repository"]) {
    assert.equal(row(run[key], key)["id"], 1316243988);
  }
  const jobs = list(response["jobs"], "Actual producer jobs").map((value) => row(value, "job"));
  assert.equal(response["total_count"], jobs.length, "Complete finite jobs census");
  assert(jobs.length > 0 && jobs.length <= 4);
  const selectedJobs = jobs.filter((job) => job["name"] === "ef70-adoption-preflight");
  assert.equal(selectedJobs.length, 1);
  const job = selectedJobs[0]!;
  assert.equal(job["status"], "completed");
  assert.equal(job["conclusion"], "success");
  assert.equal(job["head_sha"], selection.harnessRevision);
  const steps = list(job["steps"], "Actual preflight steps").map((value) => row(value, "step"));
  for (const name of preflightSteps) {
    const matches = steps.filter((step) => step["name"] === name);
    assert.equal(matches.length, 1, "Missing unique preflight step: " + name);
    assert.equal(matches[0]!["status"], "completed");
    assert.equal(matches[0]!["conclusion"], "success");
  }
  return {
    runId: selection.runId,
    attempt: 1,
    head: selection.harnessRevision,
    jobId: job["id"],
    workflow: run["path"],
    workflowId: run["workflow_id"],
    runUrl: run["html_url"],
    actualRequiredSteps: steps,
    scope:
      "Actual exact-source ordinary preflight; not trusted admission, full-ci or consumer qualification authority.",
  };
}
export async function verifyPreflight(evidence: AdoptionEvidence): Promise<Row> {
  const { preflightRunId: runId, harnessRevision } = evidence.config;
  const run = await evidence.github(
    "engineering-foundation/actions/runs/" + runId,
    "producer-preflight-run",
  );
  const jobs = await evidence.github(
    "engineering-foundation/actions/runs/" + runId + "/attempts/1/jobs?per_page=100",
    "producer-preflight-jobs",
  );
  const result = validatePreflight(run, jobs, { runId, harnessRevision });
  evidence.record("producer-preflight-verified", result);
  return result;
}
function validateOrigin(
  evidence: AdoptionEvidence,
  root: string,
  name: string,
  label: string,
): void {
  const actual = evidence.git(root, label + "-origin", ["remote", "get-url", "origin"]);
  assert(
    [
      "https://github.com/agent-teams-ai/" + name,
      "https://github.com/agent-teams-ai/" + name + ".git",
    ].includes(actual),
  );
}
function sourceTrackedImages(evidence: AdoptionEvidence): FileImage[] {
  const { consumer } = evidence.config;
  const images = inventory(consumer);
  const entries = evidence
    .command(
      "source-index",
      "/usr/bin/git",
      ["--no-replace-objects", "ls-files", "--stage", "-z"],
      consumer,
    )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const index = entries
    .map((entry) => {
      const match = /^(100644|100755|120000) ([0-9a-f]{40}) 0\t(.+)$/u.exec(entry);
      assert(match, "Only ordinary stage0 file/symlink images are supported");
      return { mode: match[1]!, blob: match[2]!, path: match[3]! };
    })
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assert.deepEqual(
    images.map((image) => image.path),
    index.map((entry) => entry.path),
    "Source contains an ignored/untracked nondependency image",
  );
  for (let position = 0; position < images.length; position += 1) {
    const image = images[position]!,
      entry = index[position]!;
    assert.equal(image.kind, "file", "Published restoration requires regular source images");
    assert.notEqual(entry.mode, "120000");
    assert.equal(
      image.mode,
      entry.mode === "100755" ? 0o755 : entry.mode === "100644" ? 0o644 : 0o777,
    );
  }
  evidence.record("source-index", index);
  evidence.record("source-full-inventory", images);
  return images;
}
export interface SourceAdmission {
  readonly tree: string;
  readonly identity: ReturnType<typeof rootIdentity>;
  readonly images: readonly FileImage[];
  readonly profile: Row;
  readonly pin: FileImage;
}
export function admitCheckouts(evidence: AdoptionEvidence): SourceAdmission {
  const c = evidence.config;
  for (const [root, revision, name, label] of [
    [c.consumer, c.sourceRevision, "extension-foundation", "consumer"],
    [c.central, c.authorityRevision, ".github", "central"],
    [c.harness, c.harnessRevision, "engineering-foundation", "harness"],
  ] as const) {
    assert.equal(evidence.git(root, label + "-head", ["rev-parse", "HEAD"]), revision);
    assert.equal(
      evidence.git(root, label + "-clean", ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
    );
    validateOrigin(evidence, root, name, label);
  }
  evidence.git(c.harness, "harness-source-ancestry", [
    "merge-base",
    "--is-ancestor",
    parentHarness,
    c.harnessRevision,
  ]);
  assert(
    !existsSync(join(c.consumer, "node_modules")),
    "Fresh canonical source installation required",
  );
  assert(
    !existsSync(join(c.consumer, ".agent-teams-local")),
    "Fresh consumer has no preexisting mutation state",
  );
  const profile = json(join(c.consumer, "architecture/foundation/docs-consumer-integration.json"));
  assert.equal(profile["schemaVersion"], 3);
  const repository = row(profile["repository"], "Source repository");
  assert.equal(repository["id"], "1333298097");
  assert.equal(repository["provider"], "github");
  assert.equal(repository["nameWithOwner"], "agent-teams-ai/extension-foundation");
  const cohort = row(profile["cohort"], "Original source cohort");
  assert.equal(cohort["schemaVersion"], 2);
  assert.equal(cohort["cohortId"], sourceCohort);
  assert.equal(json(join(c.consumer, "package.json"))["packageManager"], "pnpm@11.18.0");
  const pin = regularImage(join(c.consumer, ".node-version"));
  assert.equal(readFileSync(join(c.consumer, ".node-version"), "utf8"), "26.12.1\n");
  assert.equal(pin.mode, 0o644, "Canonical source's same-pin read guard");
  const source = {
    profile,
    pin,
    images: sourceTrackedImages(evidence),
    identity: rootIdentity(c.consumer),
    tree: evidence.git(c.consumer, "source-tree", ["rev-parse", "HEAD^{tree}"]),
  };
  evidence.record("source-admission", { ...source, sourceRevision: c.sourceRevision });
  return source;
}
export function assertSourceIdentity(
  evidence: AdoptionEvidence,
  source: SourceAdmission,
  label: string,
): void {
  assert.deepEqual(rootIdentity(evidence.config.consumer), source.identity);
  assert.equal(
    evidence.git(evidence.config.consumer, label + "-head", ["rev-parse", "HEAD"]),
    evidence.config.sourceRevision,
  );
  assert.equal(
    evidence.git(evidence.config.consumer, label + "-tree", ["rev-parse", "HEAD^{tree}"]),
    source.tree,
  );
  assert.deepEqual(regularImage(join(evidence.config.consumer, ".node-version")), source.pin);
}
export function observeRuntimes(evidence: AdoptionEvidence): void {
  const c: AdoptionConfig = evidence.config,
    runtime: Row[] = [];
  for (const [label, executable, expected] of [
    ["node24", c.node24, "24.22.3"],
    ["node26", c.node26, "26.12.1"],
  ] as const) {
    const observed = row(
      JSON.parse(
        evidence
          .command(
            label + "-physical",
            executable,
            [
              "--input-type=module",
              "--eval",
              "console.log(JSON.stringify({node:process.versions.node,platform:process.platform,architecture:process.arch}))",
            ],
            c.roots.root,
          )
          .toString("utf8"),
      ),
      "Physical runtime",
    );
    assert.deepEqual(observed, { node: expected, platform: "linux", architecture: "x64" });
    runtime.push({
      label,
      executable,
      observed,
      image: regularImage(executable, 256 * 1024 * 1024),
    });
  }
  const affinity = text(
    readFileSync("/proc/self/status", "utf8")
      .split("\n")
      .find((line) => line.startsWith("Cpus_allowed_list:")),
    "Actual own CPU affinity",
  );
  evidence.record("physical-runtime-observations", { runtime, affinity });
}
