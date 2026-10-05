import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contexts = ["check", "windows-check", "macos-qualification", "full-ci"];
const runUrl = "https://github.com/owner/repo/actions/runs/123";
const headSha = "a".repeat(40);

interface RunFixture {
  id: number;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  run_attempt: number;
  html_url: string;
  head_repository: { full_name: string };
  pull_requests: { number: number; head: { ref: string; sha: string }; base: { ref: string; sha: string } }[];
  status: string;
  conclusion: string;
}

interface JobFixture {
  id: number;
  name: string;
  run_id: number;
  head_sha: string;
  run_attempt: number;
  status: string;
  conclusion: string;
  html_url: string;
}

interface ObservationFixture {
  initial: RunFixture;
  before: RunFixture;
  after: RunFixture;
  jobs: JobFixture[];
  jobPages?: unknown;
  transportFailures: number;
  remainingSeconds: number;
}

function fixture(): ObservationFixture {
  const run: RunFixture = {
    id: 123, path: ".github/workflows/ci.yml", event: "workflow_dispatch",
    head_branch: "changeset-release/main", head_sha: headSha, run_attempt: 1,
    html_url: runUrl, head_repository: { full_name: "owner/repo" }, pull_requests: [],
    status: "completed", conclusion: "success",
  };
  return {
    initial: run, before: structuredClone(run), after: structuredClone(run), transportFailures: 0, remainingSeconds: 60,
    jobs: contexts.map((name, index) => ({
      id: 1000 + index, name, run_id: 123, head_sha: headSha, run_attempt: 1,
      status: "completed", conclusion: "success", html_url: `${runUrl}/job/${1000 + index}`,
    })),
  };
}

async function attestationSource(): Promise<string> {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const step = workflow.indexOf("      - name: Dispatch and attest release pull request checks");
  const start = workflow.indexOf("        run: |\n", step) + "        run: |\n".length;
  assert.ok(step >= 0 && start > step);
  return workflow.slice(start).replace(/^ {10}/gmu, "");
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing function: ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start);
  return source.slice(start, end + 2);
}

// Execute the actual final observation loop and publication barrier. The gh
// executable serves local API fixtures; it cannot contact GitHub or dispatch CI.
async function observe(input: ObservationFixture, sourceOverride?: string) {
  const source = sourceOverride ?? await attestationSource();
  const evidenceRoot = join(repositoryRoot, ".ci-edge-evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const sandbox = await mkdtemp(join(evidenceRoot, "ci-fixture-"));
  try {
    await Promise.all([
      writeFile(join(sandbox, "initial.json"), JSON.stringify(input.initial)),
      writeFile(join(sandbox, "before.json"), JSON.stringify(input.before)),
      writeFile(join(sandbox, "after.json"), JSON.stringify(input.after)),
      writeFile(join(sandbox, "jobs.json"), JSON.stringify(input.jobPages ?? [{ total_count: input.jobs.length, jobs: input.jobs }])),
      writeFile(join(sandbox, "reads"), "0"),
      writeFile(join(sandbox, "failures"), String(input.transportFailures)),
      writeFile(join(sandbox, "log"), ""),
    ]);
    const ghPath = join(sandbox, "gh");
    await writeFile(ghPath, `#!/bin/bash
set -eu
endpoint=""
for argument in "$@"; do [[ "$argument" != repos/* ]] || endpoint="$argument"; done
printf '%s\\n' "$endpoint" >> "$CI_FIXTURE_ROOT/log"
case "$endpoint" in
  repos/owner/repo/actions/runs/123)
    read_count="$(cat "$CI_FIXTURE_ROOT/reads")"
    if (( read_count > 0 )); then
      failures="$(cat "$CI_FIXTURE_ROOT/failures")"
      if (( failures > 0 )); then echo "$((failures - 1))" > "$CI_FIXTURE_ROOT/failures"; exit 1; fi
    fi
    echo "$((read_count + 1))" > "$CI_FIXTURE_ROOT/reads"
    case "$read_count" in
      0) cat "$CI_FIXTURE_ROOT/initial.json" ;;
      1) cat "$CI_FIXTURE_ROOT/before.json" ;;
      *) cat "$CI_FIXTURE_ROOT/after.json" ;;
    esac ;;
  repos/owner/repo/actions/runs/123/jobs*) cat "$CI_FIXTURE_ROOT/jobs.json" ;;
  repos/owner/repo/actions/runs/456/attempts/1/jobs*) echo '[{"total_count":0,"jobs":[]}]' ;;
  repos/owner/repo/commits/*/check-runs) echo '[{"total_count":0,"check_runs":[]}]' ;;
  repos/owner/repo/code-scanning/analyses) echo '[[]]' ;;
  repos/owner/repo/git/ref/heads/main) printf '%s\\n' '${"b".repeat(40)}' ;;
  repos/owner/repo/check-runs/789) echo '{"html_url":"https://github.com/owner/repo/runs/789"}' ;;
  repos/owner/repo/pulls/7|repos/owner/repo/actions/runs/456|repos/owner/repo/check-suites/987) echo '{}' ;;
  *) echo "Unexpected fixture API: $endpoint" >&2; exit 99 ;;
esac
`);
    await chmod(ghPath, 0o755);
    const control = ["fail_attestation", "fetch_paginated_pages", "paginated_object_collection", "paginated_array_collection"]
      .map(name => functionSource(source, name)).join("\n");
    const boundedReader = source.includes("read_final_ci() {") ? functionSource(source, "read_final_ci") : "";
    const terminal = source.slice(source.indexOf("final_run_verified=0"));
    const shell = `set -Eeuo pipefail
ci_contexts=(check windows-check macos-qualification full-ci)
attestation_contexts=(analyze "\${ci_contexts[@]}")
head_sha='${headSha}'; base_sha='${"b".repeat(40)}'; bound_run_id=123
bound_run_event="$(jq -r '.event' "$CI_FIXTURE_ROOT/initial.json")"; expected_run_url='${runUrl}'
RELEASE_PULL_REQUEST=7; RELEASE_RUN_URL='${runUrl}'
codeql_run_id=456; codeql_analyze_check_id=789; codeql_check_suite_id=987
codeql_receipt='{}'; codeql_evidence_error=/dev/null; final_current_main_sha="$base_sha"
observed_codeql_analyze_check='{"html_url":"https://github.com/owner/repo/runs/789"}'
conclusions=(success success success success); target_urls=(cached1 cached2 cached3 cached4)
post_status() { printf '%s|%s|%s|%s\\n' "$@"; }
mark_attestation_error() { trap - ERR; for context in "\${attestation_contexts[@]}"; do post_status "$context" error recovery "$RELEASE_RUN_URL"; done; exit 1; }
validate_codeql_collection() { cat >/dev/null; }
require_final_codeql_snapshot() { echo CodeQL-snapshot >> "$CI_FIXTURE_ROOT/log"; }
require_final_release_pr_snapshot() { echo PR-main-snapshot >> "$CI_FIXTURE_ROOT/log"; }
sleep() { SECONDS=$((SECONDS + $1)); }
${control}
${boundedReader}
trap mark_attestation_error ERR
for context in "\${attestation_contexts[@]}"; do post_status "$context" pending dispatched "$RELEASE_RUN_URL"; done
${terminal.replace("final_verification_deadline=$((SECONDS + 60))", `final_verification_deadline=$((SECONDS + ${input.remainingSeconds}))`)}
`;
    const result = spawnSync("bash", ["-c", shell], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 5000,
      env: { PATH: `${sandbox}:/usr/bin:/bin`, CI_FIXTURE_ROOT: sandbox,
        GITHUB_REPOSITORY: "owner/repo", GITHUB_SERVER_URL: "https://github.com" },
    });
    const log = (await readFile(join(sandbox, "log"), "utf8")).trim().split("\n");
    return { ...result, log };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function assertRejected(result: Awaited<ReturnType<typeof observe>>): void {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const statuses = result.stdout.trim().split("\n").map(line => line.split("|"));
  assert.ok(statuses.every(([, state]) => state !== "success"), result.stdout);
  const latest = new Map(statuses.map(([name, state]) => [name, state]));
  assert.deepEqual([...latest.keys()].toSorted(), ["analyze", ...contexts].toSorted());
  assert.ok([...latest.values()].every(state => state === "failure" || state === "error"));
}

test("final CI observations reject a rerun that starts while collecting CodeQL", async () => {
  const input = fixture();
  input.before.run_attempt = 2;
  assertRejected(await observe(input));
});

test("final CI detail after current jobs fences a rerun during the jobs read", async () => {
  const input = fixture();
  input.after.run_attempt = 2;
  assertRejected(await observe(input));
});

test("fresh gate conclusions and target URLs supply every success publication", async () => {
  const result = await observe(fixture());
  assert.equal(result.status, 0, result.stderr);
  const successes = result.stdout.trim().split("\n").filter(line => line.includes("|success|"));
  assert.equal(successes.length, 5);
  for (const [index, context] of contexts.entries()) {
    assert.equal(successes[index], `${context}|success|Release PR ${context}: success|${runUrl}/job/${1000 + index}`);
  }
  const currentJobs = result.log.indexOf("repos/owner/repo/actions/runs/123/jobs?filter=latest&per_page=100");
  assert.ok(currentJobs > result.log.lastIndexOf("PR-main-snapshot"), result.log.join("\n"));
  assert.equal(result.log[currentJobs - 1], "repos/owner/repo/actions/runs/123");
  assert.equal(result.log[currentJobs + 1], "repos/owner/repo/actions/runs/123");
});

test("the final confirmation retains validated pull-request provenance and native jobs", async () => {
  const input = fixture();
  for (const run of [input.initial, input.before, input.after]) {
    run.event = "pull_request";
    run.pull_requests = [{ number: 7, head: { ref: "changeset-release/main", sha: headSha }, base: { ref: "main", sha: "b".repeat(40) } }];
  }
  input.jobs.push({ ...input.jobs[0]!, id: 9000, name: "linux-tests-1-2", html_url: `${runUrl}/job/9000` });
  const result = await observe(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("\n").filter(line => line.includes("|success|")).length, 5);
  input.after.pull_requests[0]!.base.sha = "c".repeat(40);
  assertRejected(await observe(input));
});

test("incomplete pagination and malformed current gate records fail closed", async t => {
  const jobs = fixture().jobs;
  const pages: [string, unknown][] = [
    ["missing page", [{ total_count: 5, jobs }]],
    ["inconsistent counts", [{ total_count: 4, jobs: jobs.slice(0, 2) }, { total_count: 5, jobs: jobs.slice(2) }]],
    ["missing count", [{ jobs }]], ["missing collection", [{ total_count: 4 }]],
    ["null job", [{ total_count: 4, jobs: [null, ...jobs.slice(1)] }]],
    ["missing attempt", [{ total_count: 4, jobs: jobs.map(({ run_attempt: _attempt, ...job }) => job) }]],
    ["null conclusion", [{ total_count: 4, jobs: [{ ...jobs[0], conclusion: null }, ...jobs.slice(1)] }]],
  ];
  for (const [name, jobPages] of pages) {
    await t.test(name, async () => { const input = fixture(); input.jobPages = jobPages; assertRejected(await observe(input)); });
  }
});

test("current gates reject missing, duplicate, unsuccessful, pending and foreign jobs", async t => {
  const mutations: [string, (input: ObservationFixture) => void][] = [
    ["missing", input => { input.jobs.pop(); }],
    ["duplicate", input => { input.jobs.push(structuredClone(input.jobs[0]!)); }],
    ["foreign run", input => { input.jobs[0]!.run_id = 124; }],
    ["foreign head", input => { input.jobs[0]!.head_sha = "c".repeat(40); }],
    ["foreign attempt", input => { input.jobs[0]!.run_attempt = 2; }],
    ["duplicate ID", input => { input.jobs[1]!.id = input.jobs[0]!.id; }],
    ["invalid ID", input => { input.jobs[0]!.id = 0; }],
    ["foreign URL", input => { input.jobs[0]!.html_url = "https://example.com/job/1000"; }],
    ...["failure", "skipped", "neutral", "cancelled", "timed_out", "startup_failure", "SUCCESS", ""].map(
      (conclusion): [string, (input: ObservationFixture) => void] => [conclusion || "absent conclusion", input => { input.jobs[0]!.conclusion = conclusion; }],
    ),
    ["pending", input => { input.jobs[0]!.status = "in_progress"; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => { const input = fixture(); mutate(input); assertRejected(await observe(input)); });
  }
});

test("fresh run identity and literal success must remain unchanged on both sides", async t => {
  const mutations: [string, (run: RunFixture) => void][] = [
    ["ID", run => { run.id = 124; }], ["path", run => { run.path = ".github/workflows/foreign.yml"; }],
    ["event", run => { run.event = "pull_request"; }], ["branch", run => { run.head_branch = "main"; }],
    ["head", run => { run.head_sha = "c".repeat(40); }], ["URL", run => { run.html_url += "0"; }],
    ["source", run => { run.head_repository.full_name = "foreign/repo"; }],
    ["PR provenance", run => { run.pull_requests = [{ number: 8, head: { ref: "changeset-release/main", sha: headSha }, base: { ref: "main", sha: "b".repeat(40) } }]; }],
    ["status", run => { run.status = "in_progress"; }], ["conclusion", run => { run.conclusion = "failure"; }],
  ];
  for (const side of ["before", "after"] as const) {
    for (const [name, mutate] of mutations) {
      await t.test(`${side}: ${name}`, async () => { const input = fixture(); mutate(input[side]); assertRejected(await observe(input)); });
    }
  }
});

test("bounded final reads retry a transport failure without reusing cached gates", async () => {
  const input = fixture(); input.transportFailures = 1;
  const result = await observe(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.log.filter(line => line === "repos/owner/repo/actions/runs/123").length, 4);
  assert.ok(result.stdout.includes(`${runUrl}/job/1000`));
});

test("persistent final read failure and insufficient phase budget publish no success", async t => {
  for (const [name, transportFailures, remainingSeconds] of [["transport", 100, 60], ["budget", 0, 14]] as const) {
    await t.test(name, async () => {
      const input = fixture(); input.transportFailures = transportFailures; input.remainingSeconds = remainingSeconds;
      assertRejected(await observe(input));
    });
  }
});
