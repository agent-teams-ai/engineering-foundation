import assert from "node:assert/strict";
import test from "node:test";

import { requestFullPrCi } from "../scripts/request-full-pr-ci.mts";
import type { FullCiPort } from "../scripts/request-full-pr-ci.mts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const url = "https://github.com/example/tooling/actions/runs/101";
const prMetadata = {
  number: 7, state: "open", labels: [] as { name: string }[],
  head: { sha: head, ref: "test/fork-pr", repo: { id: 22, full_name: "fork/tooling" } },
  base: { sha: base, repo: { id: 11, full_name: "example/tooling" } },
};
function runMetadata() {
  // Shape observed by root in TEST run 37226486275: both names carry run-name;
  // workflow_id identifies the workflow. Repository/PR values are fixture-local.
  return {
    id: 101, run_attempt: 1, workflow_id: 55,
    name: `Full CI #7 @${head} on ${base}`, path: ".github/workflows/ci.yml", event: "pull_request",
    head_sha: head, head_branch: "test/fork-pr", display_title: `Full CI #7 @${head} on ${base}`,
    repository: { id: 11, full_name: "example/tooling" }, html_url: url,
    head_repository: { id: 22, full_name: "fork/tooling" },
    status: "completed", conclusion: "success",
    pull_requests: [{ number: 7, head: { sha: head, ref: "test/fork-pr", repo: { id: 22 } }, base: { sha: base, repo: { id: 11 } } }],
  };
}
function fixture() {
  const pr = structuredClone(prMetadata);
  const state = {
    pr, runs: [] as ReturnType<typeof runMetadata>[],
    workflow: { id: 55, name: "CI", path: ".github/workflows/ci.yml" },
    jobs: ["full-ci", "check", "windows-check", "macos-qualification"].map(name =>
      ({ run_id: 101, name, status: "completed", conclusion: "success" })),
    effects: [] as string[][], reads: [] as string[][], waits: [] as number[],
    repositoryLabel: true, discover: true, losePost: false, loseDelete: false,
    watch: () => {}, beforePost: () => {}, beforeReadRun: () => {},
  };
  const port: FullCiPort = {
    async gh(args, timeout) {
      const command = [...args];
      state.reads.push(command);
      assert.equal(timeout, args[0] === "run" ? 90 * 60_000 : 20_000);
      if (args[0] === "repo") { return JSON.stringify({ nameWithOwner: "example/tooling" }); }
      if (args[0] === "run") { state.waits.push(timeout); state.watch(); return ""; }
      const method = args[1] === "--method" ? args[2] : "GET";
      const endpoint = method === "GET" ? args[1]! : args[3]!;
      if (method !== "GET") {
        state.effects.push(command);
        if (method === "DELETE") {
          state.pr.labels = [];
          if (state.loseDelete) { throw new Error("response lost after DELETE"); }
          return "";
        }
        if (endpoint === "repos/example/tooling/labels") { state.repositoryLabel = true; return "{}"; }
        state.beforePost(); state.pr.labels = [{ name: "ci:full" }];
        if (state.discover) { state.runs.push({ ...runMetadata(), id: 102, html_url: url.replace("101", "102"), status: "queued", conclusion: "" }); }
        if (state.losePost) { throw new Error("response lost after POST"); }
        return "[]";
      }
      if (endpoint === "repos/example/tooling") { return JSON.stringify({ id: 11, full_name: "example/tooling" }); }
      if (endpoint === "repos/example/tooling/pulls/7") { return JSON.stringify(state.pr); }
      if (endpoint === "repos/example/tooling/actions/workflows/ci.yml") { return JSON.stringify(state.workflow); }
      if (endpoint.startsWith("repos/example/tooling/labels?")) { return JSON.stringify(state.repositoryLabel ? [{ name: "ci:full" }] : []); }
      if (endpoint.includes("/workflows/")) { return JSON.stringify({ workflow_runs: state.runs }); }
      if (endpoint.includes("/jobs?")) { return JSON.stringify({ jobs: state.jobs }); }
      if (endpoint.includes("/actions/runs/")) {
        state.beforeReadRun();
        return JSON.stringify(state.runs.find(run => String(run.id) === endpoint.split("/").at(-1)));
      }
      throw new Error(`Unexpected test request: ${command.join(" ")}`);
    },
    async delay(milliseconds) { assert.equal(milliseconds, 5000); },
  };
  return { state, port };
}

// Input mistakes must never reach a provider, including a label write.
test("malformed requests reject before GitHub IO", async () => {
  for (const args of [[], ["--pr", "0"], ["--pr", "01"], ["--pr", "-1"], ["--pr", "1;touch"],
    ["--pr", "9007199254740992"], ["--pr", "7", "--wait", "--wait"], ["--pr", "7", "--repo"], ["--wait", "--pr", "7"]]) {
    const { state, port } = fixture();
    await assert.rejects(requestFullPrCi(args, port));
    assert.deepEqual(state.reads, []);
  }
});

test("GitHub custom run-name and four successful native gates reuse a fork run without mutation", async () => {
  const { state, port } = fixture(); state.runs = [runMetadata()];
  assert.deepEqual(await requestFullPrCi(["--", "--pr", "7", "--wait"], port), { outcome: "ready", url, head, base });
  assert.deepEqual(state.effects, []); assert.deepEqual(state.waits, []);
  assert.ok(state.reads.some(args => args[1]?.includes("/attempts/1/jobs")));
  assert.ok(state.reads.some(args => args[1] === "repos/example/tooling/actions/workflows/ci.yml"));
});

// Real fork run 37227989632 has no pull_requests entries. Source repository,
// branch and the frozen event title remain independently available from GitHub.
test("real-shaped empty fork associations reuse exact source evidence but never same-repository evidence", async () => {
  const { state, port } = fixture(); const run = runMetadata(); run.pull_requests = []; state.runs = [run];
  assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
  assert.deepEqual(state.effects, []);

  const other = fixture(); const unassociated = runMetadata(); unassociated.pull_requests = [];
  other.state.pr.head.repo = { id: 11, full_name: "example/tooling" };
  unassociated.head_repository = { id: 11, full_name: "example/tooling" };
  other.state.runs = [unassociated]; other.state.discover = false;
  await assert.rejects(requestFullPrCi(["--pr", "7"], other.port), /effect uncertain/u);
  assert.deepEqual(other.state.effects.map(args => args[2]), ["POST"]);
});

test("transient reads retry boundedly while malformed JSON is never retried", async () => {
  const { state, port } = fixture(); state.runs = [runMetadata()]; const original = port.gh;
  let reads = 0; const delays: number[] = [];
  port.gh = async (args, timeout) => {
    if (args[0] === "repo" && ++reads <= 2) { throw new Error("transient read response lost"); }
    return original(args, timeout);
  };
  port.delay = async milliseconds => { delays.push(milliseconds); };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "ready");
  assert.equal(reads, 3); assert.deepEqual(delays, [250, 500]); assert.deepEqual(state.effects, []);

  const malformed = fixture(); let malformedReads = 0;
  malformed.port.gh = async () => { malformedReads += 1; return "{"; };
  await assert.rejects(requestFullPrCi(["--pr", "7"], malformed.port), SyntaxError);
  assert.equal(malformedReads, 1); assert.deepEqual(malformed.state.effects, []);
});

test("canonical workflow metadata must identify CI before a label mutation", async () => {
  for (const workflow of [{ id: 55, name: "PR Feedback", path: ".github/workflows/ci.yml" },
    { id: 55, name: "CI", path: ".github/workflows/pr-feedback.yml" },
    { id: 0, name: "CI", path: ".github/workflows/ci.yml" }]) {
    const { state, port } = fixture(); state.workflow = workflow;
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /workflow identity|identifier/u);
    assert.deepEqual(state.effects, []);
  }
});

test("a fresh fork request creates the repository label and waits for its emitted native run", async () => {
  const { state, port } = fixture(); state.repositoryLabel = false;
  state.watch = () => {
    state.runs[0]!.status = "completed"; state.runs[0]!.conclusion = "success";
    for (const job of state.jobs) { job.run_id = 102; }
  };
  assert.deepEqual(await requestFullPrCi(["--pr", "7", "--wait"], port),
    { outcome: "ready", url: url.replace("101", "102"), head, base });
  assert.deepEqual(state.effects, [
    ["api", "--method", "POST", "repos/example/tooling/labels", "-f", "name=ci:full",
      "-f", "color=0e8a16", "-f", "description=Request complete native PR qualification"],
    ["api", "--method", "POST", "repos/example/tooling/issues/7/labels", "-f", "labels[]=ci:full"],
  ]);
  assert.deepEqual(state.waits, [90 * 60_000]);
});

// Each mutation represents an independent wrong-source/stale evidence fixture.
test("dispatch, unrequested, wrong workflow/repo/PR/head/base runs cannot bless a PR", async () => {
  for (const change of [
    (r: ReturnType<typeof runMetadata>) => { r.event = "workflow_dispatch"; },
    (r: ReturnType<typeof runMetadata>) => { r.display_title = "CI pull_request run 101"; },
    (r: ReturnType<typeof runMetadata>) => { r.path = ".github/workflows/pr-feedback.yml"; },
    (r: ReturnType<typeof runMetadata>) => { r.workflow_id = 56; },
    (r: ReturnType<typeof runMetadata>) => { r.name = "CI"; },
    (r: ReturnType<typeof runMetadata>) => { r.repository.id = 12; },
    (r: ReturnType<typeof runMetadata>) => { r.repository.full_name = "other/tooling"; },
    (r: ReturnType<typeof runMetadata>) => { r.head_repository.id = 23; },
    (r: ReturnType<typeof runMetadata>) => { r.head_repository.full_name = "other/tooling"; },
    (r: ReturnType<typeof runMetadata>) => { r.head_branch = "other-branch"; },
    (r: ReturnType<typeof runMetadata>) => { r.pull_requests[0]!.number = 8; },
    (r: ReturnType<typeof runMetadata>) => { r.head_sha = "c".repeat(40); },
    (r: ReturnType<typeof runMetadata>) => { r.pull_requests[0]!.base.sha = "c".repeat(40); },
    (r: ReturnType<typeof runMetadata>) => { r.pull_requests[0]!.head.repo.id = 23; },
    (r: ReturnType<typeof runMetadata>) => { r.pull_requests[0]!.head.ref = "other-branch"; },
    (r: ReturnType<typeof runMetadata>) => { r.pull_requests[0]!.base.repo.id = 12; },
    (r: ReturnType<typeof runMetadata>) => { r.display_title = `Full CI #7 @${head} on ${"c".repeat(40)}`; },
  ]) {
    const { state, port } = fixture(); const run = runMetadata(); change(run); state.runs = [run];
    const result = await requestFullPrCi(["--pr", "7"], port);
    assert.equal(result.outcome, "requested"); assert.equal(state.effects.length, 1);
    assert.deepEqual(state.effects[0], ["api", "--method", "POST", "repos/example/tooling/issues/7/labels", "-f", "labels[]=ci:full"]);
  }
});

test("skipped, neutral, absent or duplicate gates and unsuccessful runs require a new request", async () => {
  for (const defect of ["skipped", "neutral", "missing", "duplicate", "failed-run", "cancelled", "newer-failed"]) {
    const { state, port } = fixture(); state.runs = [runMetadata()]; state.pr.labels = [{ name: "ci:full" }];
    if (defect === "missing") { state.jobs = []; }
    else if (defect === "duplicate") { state.jobs.push({ ...state.jobs[0]! }); }
    else if (defect === "failed-run" || defect === "cancelled") { state.runs[0]!.conclusion = defect === "cancelled" ? "cancelled" : "failure"; }
    else if (defect === "newer-failed") { state.runs.push({ ...runMetadata(), id: 102, html_url: url.replace("101", "102"), conclusion: "failure" }); state.discover = false; }
    else { state.jobs[0]!.conclusion = defect; }
    if (defect === "newer-failed") { await assert.rejects(requestFullPrCi(["--pr", "7"], port), /uncertain/u); }
    else { assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested"); }
    assert.deepEqual(state.effects.map(args => args[2]), ["DELETE", "POST"]);
  }
});

// The parallel full-ci job may succeed while a legacy aggregate fails to start.
// Checking only full-ci would wrongly report ready for each fixture below.
test("each of the four gates must have one actual successful job in the bound run", async () => {
  for (const name of ["full-ci", "check", "windows-check", "macos-qualification"]) {
    for (const defect of ["missing", "duplicate", "skipped", "neutral", "failure", "cancelled", "wrong-run", "pending"]) {
      const { state, port } = fixture(); state.runs = [runMetadata()];
      const job = state.jobs.find(entry => entry.name === name)!;
      if (defect === "missing") { state.jobs = state.jobs.filter(entry => entry !== job); }
      else if (defect === "duplicate") { state.jobs.push({ ...job }); }
      else if (defect === "wrong-run") { job.run_id = 99; }
      else if (defect === "pending") { job.status = "in_progress"; }
      else { job.conclusion = defect; }
      assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested", `${name}: ${defect}`);
      assert.equal(state.effects.length, 1, `${name}: ${defect} must not reuse invalid evidence`);
    }
  }
});

test("in-progress requests are reused and bounded watch rereads the actual gate", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), status: "in_progress", conclusion: "" }];
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  state.watch = () => { state.runs[0]!.status = "completed"; state.runs[0]!.conclusion = "success"; };
  assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
  assert.deepEqual(state.effects, []); assert.deepEqual(state.waits, [90 * 60_000]);
});

// A queued list snapshot can lag fresh detail during a legitimate transition.
// It must not cause a duplicate request or discard successful job evidence.
test("stale run-list lifecycle state does not invalidate the same current attempt", async () => {
  for (const status of ["in_progress", "completed"] as const) {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), status, conclusion: status === "completed" ? "success" : "" }];
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      if (args[1]?.includes("/actions/workflows/ci.yml/runs?")) {
        return JSON.stringify({ workflow_runs: state.runs.map(run => ({ ...run, status: "queued", conclusion: "" })) });
      }
      return gh(args, timeout);
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome,
      status === "completed" ? "ready" : "requested");
    assert.deepEqual(state.effects, []);
  }
});

test("failed or skipped watched work never reports ready", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const { state, port } = fixture(); state.runs = [{ ...runMetadata(), status: "queued", conclusion: "" }];
    state.watch = () => { state.runs[0]!.status = "completed"; state.runs[0]!.conclusion = conclusion; throw new Error("watch failed"); };
    await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /not successful/u);
    assert.deepEqual(state.effects, []);
  }
});

test("head/base changes before effects, during request and during wait fail closed", async () => {
  for (const field of ["head", "base"] as const) {
    for (const phase of ["request", "wait", "reuse"]) {
      const { state, port } = fixture();
      const change = () => { state.pr[field].sha = "c".repeat(40); };
      if (phase === "request") { state.beforePost = change; }
      else { state.runs = [runMetadata()];
        if (phase === "wait") { state.runs[0]!.status = "queued"; state.watch = change; }
        else { state.beforeReadRun = change; }
      }
      await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /head\/base changed/u);
    }
  }
  const { state, port } = fixture(); state.repositoryLabel = false;
  const original = port.gh;
  port.gh = async (args, timeout) => { const result = await original(args, timeout);
    if (args[1] === "--method" && args[3] === "repos/example/tooling/labels") { state.pr.head.sha = "c".repeat(40); }
    return result;
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /head\/base changed/u);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
});

test("changed PR source repository or branch cannot reuse success from the same head/base", async () => {
  for (const field of ["id", "full_name", "ref"] as const) {
    const { state, port } = fixture(); state.runs = [runMetadata()];
    state.beforeReadRun = () => {
      if (field === "id") { state.pr.head.repo.id = 23; }
      else if (field === "full_name") { state.pr.head.repo.full_name = "other/tooling"; }
      else { state.pr.head.ref = "other-branch"; }
    };
    await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /head\/base changed/u);
    assert.deepEqual(state.effects, []);
  }
});

test("lost label responses reconcile once without repeating a POST or DELETE", async () => {
  const { state, port } = fixture(); state.pr.labels = [{ name: "ci:full" }];
  state.losePost = true; state.loseDelete = true;
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.deepEqual(state.effects.map(args => args[2]), ["DELETE", "POST"]);
});

test("undiscovered effects stay uncertain after bounded observations", async () => {
  const { state, port } = fixture(); state.losePost = true; state.discover = false;
  let delays = 0; port.delay = async () => { delays += 1; };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /effect uncertain/u);
  assert.equal(state.effects.length, 1); assert.equal(delays, 11);
});

test("metadata truncation fails before mutation and changed run attempts reject reuse", async () => {
  const { state, port } = fixture(); state.runs = Array.from({ length: 100 }, () => runMetadata());
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /300-entry bound/u);
  assert.deepEqual(state.effects, []);
  const other = fixture(); other.state.runs = [runMetadata()];
  other.state.beforeReadRun = () => { other.state.runs[0]!.run_attempt = 2; };
  await assert.rejects(requestFullPrCi(["--pr", "7"], other.port), /attempt changed/u);
});

test("a newer failing request observed during reuse cannot be hidden by older success", async () => {
  const { state, port } = fixture(); state.runs = [runMetadata()];
  state.beforeReadRun = () => {
    state.runs.push({ ...runMetadata(), id: 103, html_url: url.replace("101", "103"), conclusion: "failure" });
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /Latest bound CI request changed/u);
  assert.deepEqual(state.effects, []);
});
