import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../ef70-managed-adoption/files.ts";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { admittedNames, assertManifestEntry } from "./artifact-intake.ts";
import {
  assertCaller,
  recoveryPreflightSteps,
  validateOriginalRun,
  validateRecoveryPreflight,
} from "./artifact-admission.ts";
import { assertForeignImages, verifyLineage } from "./checkouts.ts";
import { restoreArguments } from "./transition.ts";
import { type ArtifactSelection } from "./configuration.ts";

const expectedSteps = [
  "Install the ordinary producer profile",
  "Build current producer source with its admitted compiler",
  "Run explicit Stack cleanup and require unchanged source",
  "Provision the unchanged frozen managed test tools",
  "Check the complete actual committed delta",
  "Run the unchanged required fast route",
  "Qualify workflow security",
  "Check canonical adoption admission and failure contracts",
  "Check committed recovery admission and intake contracts",
];
const h2 = "6dace52e007d00a3df3974b75c1491f9e2648607";
test("actual caller binds the checkout and historical/current input tuples independently", () => {
  const originalFields = {
    harness_revision: h2,
    preflight_run_id: "123",
    authority_revision: "a".repeat(40),
    target_cohort: "docs-original-qualified",
  };
  const original = {
    on: {
      push: {
        branches: ["docs/coordinated-module-foundation-20261126"],
        paths: [".github/workflows/ef70-managed-campaign.yml"],
      },
    },
    jobs: {
      adoption: {
        uses:
          "agent-teams-ai/engineering-foundation/.github/workflows/ef70-canonical-adoption.yml@" +
          h2,
        with: { ...originalFields },
      },
    },
  };
  assertCaller(original, h2, originalFields, false);
  assert.throws(() =>
    assertCaller(original, h2, { ...originalFields, authority_revision: "b".repeat(40) }, false),
  );
  original.jobs.adoption.with.harness_revision = "d".repeat(40);
  assert.throws(() => assertCaller(original, h2, originalFields, false));
  const revision = "e".repeat(40);
  const currentFields = {
    harness_revision: revision,
    preflight_run_id: "456",
    authority_revision: "b".repeat(40),
    adoption_run_id: "12",
    adoption_run_attempt: "1",
    adoption_artifact_id: "34",
    adoption_artifact_digest: "sha256:" + "a".repeat(64),
    preparation_digest: "sha256:" + "b".repeat(64),
  };
  const current = {
    on: { push: { branches: ["docs/coordinated-module-foundation-20261126"] } },
    jobs: {
      recovery: {
        uses:
          "agent-teams-ai/engineering-foundation/.github/workflows/ef70-committed-recovery.yml@" +
          revision,
        with: { ...currentFields },
      },
    },
  };
  assertCaller(current, revision, currentFields, true);
  assert.throws(() =>
    assertCaller(
      { ...current, on: { push: { ...current.on.push, paths: ["README.md"] } } },
      revision,
      currentFields,
      true,
    ),
  );
  current.jobs.recovery.with.preparation_digest = "sha256:" + "c".repeat(64);
  assert.throws(() => assertCaller(current, revision, currentFields, true));
});
function preflight() {
  const config = { preflightRunId: "123", harnessRevision: "b".repeat(40) };
  const repo = { id: 1316243988, full_name: "agent-teams-ai/engineering-foundation" };
  const run = {
    id: 123,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_sha: config.harnessRevision,
    head_branch: "test/ef70-committed-recovery",
    path: ".github/workflows/ef70-committed-recovery.yml",
    repository: repo,
    head_repository: repo,
  };
  const job = {
    id: 456,
    name: "ef70-recovery-preflight",
    status: "completed",
    conclusion: "success",
    head_sha: config.harnessRevision,
    steps: expectedSteps.map((name) => ({ name, status: "completed", conclusion: "success" })),
  };
  return { config, run, jobs: { total_count: 1, jobs: [job] } };
}
test("source preflight requires all nine independently named gates and a complete census", () => {
  assert.deepEqual([...recoveryPreflightSteps], expectedSteps);
  const f = preflight();
  assert.equal(validateRecoveryPreflight(f.run, f.jobs, f.config)["attempt"], 1);
  f.jobs.jobs[0]!.steps.pop();
  assert.throws(() => validateRecoveryPreflight(f.run, f.jobs, f.config));
  const missingPage = preflight();
  missingPage.jobs.total_count = 2;
  assert.throws(() =>
    validateRecoveryPreflight(missingPage.run, missingPage.jobs, missingPage.config),
  );
});
function adoption() {
  const selection: ArtifactSelection = {
    runId: "12",
    attempt: "1",
    artifactId: "34",
    artifactDigest: "sha256:" + "a".repeat(64),
    preparationDigest: "sha256:" + "b".repeat(64),
  };
  const revision = "c".repeat(40),
    repo = { id: 1333298097, full_name: "agent-teams-ai/extension-foundation" };
  const marker: Row = {
    schemaVersion: 1,
    evidenceClass: "actual-published-canonical-adoption",
    outcome: "prepare-finalize-installed-check-complete",
    harnessRevision: h2,
    sourceRevision: revision,
    hostRunId: "12",
    hostRunAttempt: "1",
    preparation: { sha256: selection.preparationDigest },
  };
  const run: Row = {
    id: 12,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_sha: revision,
    head_branch: "docs/coordinated-module-foundation-20261126",
    path: ".github/workflows/ef70-managed-campaign.yml",
    repository: repo,
    head_repository: repo,
    referenced_workflows: [
      {
        path:
          "agent-teams-ai/engineering-foundation/.github/workflows/ef70-canonical-adoption.yml@" +
          h2,
        sha: h2,
      },
    ],
  };
  const jobs: Row = {
    total_count: 1,
    jobs: [
      {
        id: 56,
        name: "caller / ef70-canonical-adoption",
        head_sha: revision,
        status: "completed",
        conclusion: "success",
        steps: [
          "Install the exact producer harness dependencies",
          "Authenticate and execute the canonical public transition",
          "Emit bounded actual evidence for read-only observation",
          "Retain actual diagnostics and canonical adoption evidence",
        ].map((name) => ({ name, status: "completed", conclusion: "success" })),
      },
    ],
  };
  const artifact: Row = {
    id: 34,
    expired: false,
    digest: selection.artifactDigest,
    name: "ef70-canonical-adoption-" + revision + "-12-1",
    workflow_run: {
      id: 12,
      head_sha: revision,
      repository_id: 1333298097,
      head_repository_id: 1333298097,
      head_branch: "docs/coordinated-module-foundation-20261126",
    },
  };
  return { run, jobs, artifact, selection, marker };
}
test("original artifact admission binds exact successful EF run, source and immutable H2", () => {
  const f = adoption();
  assert.equal(
    validateOriginalRun(f.run, f.jobs, f.artifact, f.selection, f.marker)["artifactId"],
    "34",
  );
  for (const field of ["id", "digest", "expired", "name"]) {
    const bad = { ...f.artifact, [field]: field === "expired" ? true : "wrong" };
    assert.throws(() => validateOriginalRun(f.run, f.jobs, bad, f.selection, f.marker));
  }
  for (const field of ["run_attempt", "head_sha", "event", "conclusion"]) {
    assert.throws(() =>
      validateOriginalRun(
        { ...f.run, [field]: "wrong" },
        f.jobs,
        f.artifact,
        f.selection,
        f.marker,
      ),
    );
  }
  assert.throws(() =>
    validateOriginalRun(f.run, f.jobs, f.artifact, f.selection, {
      ...f.marker,
      sourceRevision: "d".repeat(40),
    }),
  );
  row((f.run["referenced_workflows"] as unknown[])[0], "Fixture workflow")["sha"] = "e".repeat(40);
  assert.throws(() => validateOriginalRun(f.run, f.jobs, f.artifact, f.selection, f.marker));
});
test("archive namespace admits literal members and rejects aliases, globs, controls and duplicates", () => {
  const prefix = "ef70-evidence-12-1/";
  assert.deepEqual(admittedNames(prefix + "bootstrap/a.json\n", prefix), [
    prefix + "bootstrap/a.json",
  ]);
  for (const suffix of ["../a", "/a", "a//b", "a/./b", "a*", "a?", "a[0]", "a\\b", "a\r", "a\0"]) {
    assert.throws(() => admittedNames(prefix + suffix + "\n", prefix), suffix);
  }
  assert.throws(() => admittedNames(prefix + "a\n" + prefix + "a\n", prefix));
  assert.throws(() => admittedNames(prefix + "A\n" + prefix + "a\n", prefix));
  assert.throws(() => admittedNames("ef70-evidence-13-1/a\n", prefix));
});
test("actual retained bytes must match declared size and hash; ZIP link modes confer no authority", () => {
  const content = Buffer.from("real bytes\n"),
    entry = { kind: "file", bytes: content.length, sha256: sha256(content) };
  assertManifestEntry(content, entry);
  assert.throws(() => assertManifestEntry(Buffer.from("changed\n"), entry));
  assert.throws(() => assertManifestEntry(content, { ...entry, bytes: content.length + 1 }));
  assert.throws(() => assertManifestEntry(content, { ...entry, kind: "symlink" }));
});
test("actual C ancestry, current HEAD and tree are checked on real disposable Git history", () => {
  const directory = mkdtempSync(join(tmpdir(), "ef70-recovery-lineage-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: readonly string[]) =>
    execFileSync("/usr/bin/git", ["--no-replace-objects", ...args], {
      cwd: directory,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(["init", "--quiet"]);
    writeFileSync(join(directory, "source.txt"), "C\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "test: source"]);
    const originalRevision = git(["rev-parse", "HEAD"]),
      originalTree = git(["rev-parse", "HEAD^{tree}"]);
    writeFileSync(join(directory, "host.txt"), "independent Host\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "test: final"]);
    const currentRevision = git(["rev-parse", "HEAD"]),
      currentTree = git(["rev-parse", "HEAD^{tree}"]);
    const expected = { originalRevision, originalTree, currentRevision, currentTree };
    verifyLineage(git, expected);
    assert.throws(() => verifyLineage(git, { ...expected, currentRevision: originalRevision }));
    assert.throws(() => verifyLineage(git, { ...expected, originalTree: currentTree }));
    git(["checkout", "--quiet", "--orphan", "unrelated"]);
    git(["commit", "--quiet", "-m", "test: unrelated"]);
    assert.throws(() =>
      verifyLineage(git, { ...expected, currentRevision: git(["rev-parse", "HEAD"]) }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: false });
  }
});
test("foreign F files remain exact, including the retained final caller", () => {
  const before = [
    { path: "package.json", kind: "file" as const, mode: 0o644, bytes: 4, sha256: "managed" },
    {
      path: ".github/workflows/ef70-managed-campaign.yml",
      kind: "file" as const,
      mode: 0o644,
      bytes: 5,
      sha256: "caller",
    },
  ];
  assertForeignImages(
    before,
    [{ ...before[0]!, sha256: "restored" }, before[1]!],
    ["package.json"],
  );
  assert.throws(() =>
    assertForeignImages(
      before,
      [
        { ...before[0]!, sha256: "restored" },
        { ...before[1]!, sha256: "changed" },
      ],
      ["package.json"],
    ),
  );
});
test("first current selection invokes actual restore once with both immutable witnesses", () => {
  const args = restoreArguments({
    consumer: "/owned/current",
    targetCohort: "docs-new",
    revision: "F",
    tree: "TREE",
    preparation: "/evidence/P",
    digest: "sha256:P",
    selection: "/evidence/NEW",
  });
  assert.deepEqual(args, [
    "restore",
    "--consumer",
    "/owned/current",
    "--from",
    "docs-new",
    "--to",
    "docs-2026-10-03-stable31",
    "--source-generation",
    "3",
    "--target-generation",
    "2",
    "--preparation",
    "/evidence/P",
    "--expect",
    "sha256:P",
    "--current-revision",
    "F",
    "--current-tree",
    "TREE",
    "--selection",
    "/evidence/NEW",
    "--json",
  ]);
  assert(
    !args.includes("--selection-expect") &&
      !args.includes("--prepare") &&
      !args.includes("--proof"),
  );
});
