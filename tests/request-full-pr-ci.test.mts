import assert from "node:assert/strict";
import test from "node:test";

import { createFullCiPort, readFullPrCi, requestFullPrCi } from "../scripts/request-full-pr-ci.mts";
import type { FullCiPort } from "../scripts/request-full-pr-ci.mts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const baseRef = "main";
const url = "https://github.com/example/tooling/actions/runs/101";
const prMetadata = {
  number: 7, state: "open", labels: [] as { name: string }[],
  head: { sha: head, ref: "test/fork-pr", repo: { id: 22, full_name: "fork/tooling" } },
  base: { sha: base, ref: baseRef, repo: { id: 11, full_name: "example/tooling" } },
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
    pull_requests: [{ number: 7, head: { sha: head, ref: "test/fork-pr", repo: { id: 22 } }, base: { sha: base, ref: baseRef, repo: { id: 11 } } }],
  };
}
interface JobMetadata {
  id?: number; run_id: number; run_attempt?: number; head_sha?: string;
  name: string; status: string; conclusion: string;
}
function fixture() {
  const pr = structuredClone(prMetadata);
  const state = {
    pr, runs: [] as ReturnType<typeof runMetadata>[],
    workflow: { id: 55, name: "CI", path: ".github/workflows/ci.yml" },
    jobs: ["full-ci", "check", "windows-check", "macos-qualification"].map((name, index): JobMetadata =>
      ({ id: 1001 + index, run_id: 101, run_attempt: 1, head_sha: head, name, status: "completed", conclusion: "success" })),
    effects: [] as string[][], reads: [] as string[][], waits: [] as number[],
    labels: new Map<string, { name: string; description: string }>(),
    user: { type: "User", id: 31, login: "operator" },
    discover: true, losePost: false, loseCreate: false, failCreate: false, foreignCreate: false,
    discoverRerun: true, loseRerun: false, delays: [] as number[],
    watch: () => {}, beforePost: () => {}, beforeReadRun: () => {}, afterCreate: () => {},
  };
  function rerunFailed(args: readonly string[]): string {
    state.effects.push([...args]);
    assert.deepEqual(args, ["run", "rerun", args[2], "--repo", "example/tooling", "--failed"]);
    if (state.discoverRerun) {
      const run = state.runs.find(entry => String(entry.id) === args[2])!;
      run.run_attempt += 1; run.status = "queued"; run.conclusion = "";
      // GitHub's latest jobs response clones carried successful jobs into
      // the new attempt. This is not a union of historical job responses.
      for (const job of state.jobs) { job.run_attempt = run.run_attempt; job.run_id = run.id; }
    }
    if (state.loseRerun) { throw new Error("rerun response lost"); }
    return "";
  }
  const port: FullCiPort = {
    async gh(args, timeout) {
      const command = [...args];
      state.reads.push(command);
      assert.equal(timeout, args[1] === "watch" ? 90 * 60_000 : 20_000);
      if (args[0] === "repo") { return JSON.stringify({ nameWithOwner: "example/tooling" }); }
      if (args[0] === "run" && args[1] === "watch") { state.waits.push(timeout); state.watch(); return ""; }
      if (args[0] === "run" && args[1] === "rerun") { return rerunFailed(args); }
      const method = args[1] === "--method" ? args[2] : "GET";
      const endpoint = method === "GET" ? args[1]! : args[3]!;
      if (method !== "GET") {
        state.effects.push(command);
        assert.equal(method, "POST", "automated recovery must never delete a label");
        if (endpoint === "repos/example/tooling/labels") {
          const name = args.find(arg => arg.startsWith("name="))!.slice(5);
          const description = args.find(arg => arg.startsWith("description="))!.slice(12);
          if (state.labels.has(name)) { throw new Error("HTTP 422: label already exists"); }
          if (state.failCreate) { throw new Error("create failed before any effect"); }
          state.labels.set(name, { name, description: state.foreignCreate
            ? "ci-full:v1:pr:7:owner:ffffffff-ffff-4fff-8fff-ffffffffffff" : description });
          state.afterCreate();
          if (state.loseCreate || state.foreignCreate) { throw new Error("create response lost"); }
          return "{}";
        }
        assert.equal(endpoint, "repos/example/tooling/issues/7/labels");
        state.beforePost(); state.pr.labels.push({ name: args.find(arg => arg.startsWith("labels[]="))!.slice(9) });
        if (state.discover) {
          const id = Math.max(101, ...state.runs.map(run => run.id)) + 1;
          state.runs.push({ ...runMetadata(), id, html_url: url.replace("101", String(id)), status: "queued", conclusion: "" });
        }
        if (state.losePost) { throw new Error("response lost after POST"); }
        return "[]";
      }
      if (endpoint === "user") { return JSON.stringify(state.user); }
      if (endpoint === "repos/example/tooling") { return JSON.stringify({ id: 11, full_name: "example/tooling" }); }
      if (endpoint === "repos/example/tooling/pulls/7") { return JSON.stringify(state.pr); }
      if (endpoint === "repos/example/tooling/actions/workflows/ci.yml") { return JSON.stringify(state.workflow); }
      if (endpoint.startsWith("repos/example/tooling/labels?")) { return JSON.stringify([{ name: "ci:full" }]); }
      if (endpoint.startsWith("repos/example/tooling/labels/")) {
        const name = decodeURIComponent(endpoint.split("/").at(-1)!);
        const label = state.labels.get(name);
        if (!label) { throw new Error("HTTP 404: no repository label"); }
        return JSON.stringify(label);
      }
      if (endpoint.includes("/workflows/")) { return JSON.stringify({ workflow_runs: state.runs }); }
      if (endpoint.includes("/jobs?")) {
        const attempt = /\/attempts\/([0-9]+)\/jobs/u.exec(endpoint)?.[1];
        return JSON.stringify({ jobs: attempt === undefined ? state.jobs : state.jobs.filter(job => job.run_attempt === Number(attempt)) });
      }
      if (endpoint.includes("/actions/runs/")) {
        state.beforeReadRun();
        return JSON.stringify(state.runs.find(run => String(run.id) === endpoint.split("/").at(-1)));
      }
      throw new Error(`Unexpected test request: ${command.join(" ")}`);
    },
    async delay(milliseconds) { state.delays.push(milliseconds); },
  };
  return { state, port };
}

type FixtureState = ReturnType<typeof fixture>["state"];
const sourceChanges: readonly ((state: FixtureState) => void)[] = [
  state => { state.pr.head.sha = "c".repeat(40); },
  state => { state.pr.base.sha = "c".repeat(40); },
  state => { state.pr.base.ref = "canary"; },
  state => { state.pr.head.repo.id = 23; },
  state => { state.pr.head.repo.full_name = "other/tooling"; },
  state => { state.pr.head.ref = "other-branch"; },
];

// Input mistakes must never reach a provider, including a label write.
test("malformed requests reject before GitHub IO", async () => {
  for (const args of [[], ["--pr", "0"], ["--pr", "01"], ["--pr", "-1"], ["--pr", "1;touch"],
    ["--pr", "9007199254740992"], ["--pr", "7", "--wait", "--wait"], ["--pr", "7", "--repo"], ["--wait", "--pr", "7"]]) {
    const { state, port } = fixture();
    await assert.rejects(requestFullPrCi(args, port));
    assert.deepEqual(state.reads, []);
  }
});

test("two simultaneous helpers reserve one writer and emit exactly one labeled event", async () => {
  const { state, port } = fixture();
  // The shared backend emits an event on EVERY attachment POST, including an
  // identical label. Only atomic repository-label creation can serialize it.
  const results = await Promise.all([requestFullPrCi(["--pr", "7"], port), requestFullPrCi(["--pr", "7"], port)]);
  assert.equal(results[0]!.url, results[1]!.url);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 1);
  assert.equal(state.runs.length, 1); assert.equal(state.labels.size, 1);
  const reservation = [...state.labels.values()][0]!;
  assert.match(reservation.name, /^ci:full:[a-f0-9]{40}$/u);
  assert.match(reservation.description, /^ci-full:v1:pr:7:owner:[a-f0-9-]{36}$/u);
  assert.ok(Buffer.byteLength(reservation.description) <= 100);
  assert.ok(state.reads.every(args => !args[1]?.startsWith("repos/example/tooling/labels?")));
});

test("suppressed installation credentials reject before all request and retry writes", async () => {
  for (const retry of [false, true]) {
    const { state, port } = fixture();
    if (retry) { state.runs = [{ ...runMetadata(), conclusion: "failure" }]; }
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      if (args[1] === "user") { throw new Error("HTTP 403: Resource not accessible by integration"); }
      return gh(args, timeout);
    };
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /user-authenticated/u);
    assert.deepEqual(state.effects, []);
  }
});

test("GitHub custom run-name and four successful native gates reuse a fork run without mutation", async () => {
  const { state, port } = fixture(); state.runs = [runMetadata()];
  assert.deepEqual(await requestFullPrCi(["--", "--pr", "7", "--wait"], port), { outcome: "ready", url, head, base, baseRef });
  assert.deepEqual(state.effects, []); assert.deepEqual(state.waits, []);
  assert.ok(state.reads.some(args => args[1]?.includes("/actions/runs/101/jobs?filter=latest")));
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
  assert.deepEqual(other.state.effects.map(args => args[2]), ["POST", "POST"]);
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

test("a fresh fork request creates the repository reservation and waits for its emitted native run", async () => {
  const { state, port } = fixture();
  state.watch = () => {
    state.runs[0]!.status = "completed"; state.runs[0]!.conclusion = "success";
    for (const job of state.jobs) { job.run_id = 102; }
  };
  assert.deepEqual(await requestFullPrCi(["--pr", "7", "--wait"], port),
    { outcome: "ready", url: url.replace("101", "102"), head, base, baseRef });
  const reservation = [...state.labels.values()][0]!;
  assert.match(reservation.name, /^ci:full:[a-f0-9]{40}$/u);
  assert.deepEqual(state.effects[1],
    ["api", "--method", "POST", "repos/example/tooling/issues/7/labels", "-f", `labels[]=${reservation.name}`]);
  assert.equal(state.effects.length, 2);
  const created = state.reads.findIndex(args => args[3] === "repos/example/tooling/labels");
  const confirmed = state.reads.findIndex(args => args[1] === `repos/example/tooling/labels/${encodeURIComponent(reservation.name)}`);
  const attached = state.reads.findIndex(args => args[3]?.includes("/issues/"));
  assert.ok(created < confirmed && confirmed < attached, "even successful creation must be read back before attachment");
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
    (r: ReturnType<typeof runMetadata>) => { r.pull_requests[0]!.base.ref = "canary"; },
    (r: ReturnType<typeof runMetadata>) => { r.display_title = `Full CI #7 @${head} on ${"c".repeat(40)}`; },
  ]) {
    const { state, port } = fixture(); const run = runMetadata(); change(run); state.runs = [run];
    const result = await requestFullPrCi(["--pr", "7"], port);
    assert.equal(result.outcome, "requested"); assert.equal(state.effects.length, 2);
    assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 1);
  }
});

test("malformed successful evidence fails closed while unsuccessful runs retry only failed jobs", async () => {
  for (const defect of ["skipped", "neutral", "missing", "duplicate", "failed-run", "cancelled", "newer-failed"]) {
    const { state, port } = fixture(); state.runs = [runMetadata()]; state.pr.labels = [{ name: "ci:full" }];
    if (defect === "missing") { state.jobs = []; }
    else if (defect === "duplicate") { state.jobs.push({ ...state.jobs[0]! }); }
    else if (defect === "failed-run" || defect === "cancelled") { state.runs[0]!.conclusion = defect === "cancelled" ? "cancelled" : "failure"; }
    else if (defect === "newer-failed") { state.runs.push({ ...runMetadata(), id: 102, html_url: url.replace("101", "102"), conclusion: "failure" }); state.discover = false; }
    else { state.jobs[0]!.conclusion = defect; }
    if (["failed-run", "cancelled", "newer-failed"].includes(defect)) {
      assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
      assert.equal(state.effects.length, 2);
      assert.equal(state.effects[1]![1], "rerun");
      assert.equal(state.effects[1]![2], defect === "newer-failed" ? "102" : "101");
      assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
    } else {
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /malformed gate evidence/u);
      assert.deepEqual(state.effects, []);
    }
    assert.deepEqual(state.pr.labels, [{ name: "ci:full" }]);
  }
});

// The parallel full-ci job may succeed while a legacy aggregate fails to start.
// Checking only full-ci would wrongly report ready for each fixture below.
test("each of the four gates must have one actual successful job in the bound run", async () => {
  for (const name of ["full-ci", "check", "windows-check", "macos-qualification"]) {
    for (const defect of ["missing", "duplicate", "skipped", "neutral", "failure", "cancelled", "wrong-run", "pending",
      "wrong-head", "missing-head", "future-attempt", "zero-attempt", "fractional-attempt", "missing-attempt", "missing-id", "zero-id", "duplicate-id"]) {
      const { state, port } = fixture(); state.runs = [runMetadata()];
      const job = state.jobs.find(entry => entry.name === name)!;
      if (defect === "missing") { state.jobs = state.jobs.filter(entry => entry !== job); }
      else if (defect === "duplicate") { state.jobs.push({ ...job }); }
      else if (defect === "wrong-run") { job.run_id = 99; }
      else if (defect === "wrong-head") { job.head_sha = "c".repeat(40); }
      else if (defect === "missing-head") { delete job.head_sha; }
      else if (defect === "future-attempt") { job.run_attempt = 2; }
      else if (defect === "zero-attempt") { job.run_attempt = 0; }
      else if (defect === "fractional-attempt") { job.run_attempt = 1.5; }
      else if (defect === "missing-attempt") { delete job.run_attempt; }
      else if (defect === "missing-id") { delete job.id; }
      else if (defect === "zero-id") { job.id = 0; }
      else if (defect === "duplicate-id") { job.id = state.jobs.find(entry => entry !== job)!.id; }
      else if (defect === "pending") { job.status = "in_progress"; }
      else { job.conclusion = defect; }
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /malformed gate evidence/u, `${name}: ${defect}`);
      assert.deepEqual(state.effects, [], `${name}: ${defect} must not reuse invalid evidence or submit fresh work`);
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
  const { state, port } = fixture();
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

test("lost creation and attachment responses reconcile once and preserve the legacy label", async () => {
  const { state, port } = fixture(); state.pr.labels = [{ name: "ci:full" }];
  state.losePost = true; state.loseCreate = true;
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.deepEqual(state.effects.map(args => args[2]), ["POST", "POST"]);
  assert.ok(state.pr.labels.some(label => label.name === "ci:full"));
});

test("undiscovered effects stay uncertain after bounded observations", async () => {
  const { state, port } = fixture(); state.losePost = true; state.discover = false;
  let delays = 0; port.delay = async () => { delays += 1; };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /effect uncertain/u);
  assert.equal(state.effects.length, 2); assert.equal(delays, 11);
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

// RED: a missing branch or a retarget to an equal-SHA branch used to pass the
// SHA-only snapshot guard. Neither can authorize reuse or a PR label mutation.
test("the actual PR base branch is required and returned without a main-only default", async () => {
  for (const ref of [undefined, null, "", 17]) {
    const { state, port } = fixture(); const gh = port.gh;
    port.gh = async (args, timeout) => {
      const response = await gh(args, timeout);
      return args[1] === "repos/example/tooling/pulls/7"
        ? JSON.stringify({ ...state.pr, base: { ...state.pr.base, ref } }) : response;
    };
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /base branch/u);
    assert.deepEqual(state.effects, []);
  }
  const { state, port } = fixture(); const run = runMetadata();
  state.pr.base.ref = "test/canary"; run.pull_requests[0]!.base.ref = "test/canary"; state.runs = [run];
  assert.deepEqual(await requestFullPrCi(["--pr", "7", "--wait"], port),
    { outcome: "ready", url, head, base, baseRef: "test/canary" });
  assert.deepEqual(state.effects, []);
});

test("equal-SHA base branch retargets before effects, during request, reuse and watch fail closed", async () => {
  for (const phase of ["before-effects", "request", "reuse", "watch"]) {
    const { state, port } = fixture(); const retarget = () => { state.pr.base.ref = "test/canary"; };
    if (phase === "before-effects") {
      state.pr.labels = [{ name: "ci:full" }]; const gh = port.gh; let reads = 0;
      port.gh = async (args, timeout) => {
        if (args[1] === "repos/example/tooling/pulls/7" && ++reads === 2) { retarget(); }
        return gh(args, timeout);
      };
    } else if (phase === "request") { state.beforePost = retarget; }
    else {
      state.runs = [runMetadata()];
      if (phase === "reuse") { state.beforeReadRun = retarget; }
      else { state.runs[0]!.status = "queued"; state.watch = retarget; }
    }
    await assert.rejects(requestFullPrCi(phase === "watch" ? ["--pr", "7", "--wait"] : ["--pr", "7"], port),
      /head\/base changed/u, phase);
    assert.equal(state.effects.length, phase === "request" ? 2 : 0, phase);
  }
});

// RED: GitHub can associate the same commit with other PRs; rejecting the entire
// collection used to emit a duplicate request despite one exact requested PR.
test("one exact requested association permits unrelated PR entries in either order", async () => {
  for (const reverse of [false, true]) {
    const { state, port } = fixture(); const run = runMetadata();
    run.pull_requests.push({ number: 8, head: { sha: "c".repeat(40), ref: "other", repo: { id: 23 } },
      base: { sha: "d".repeat(40), ref: "other-base", repo: { id: 11 } } });
    if (reverse) { run.pull_requests.reverse(); }
    state.runs = [run];
    assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
    assert.deepEqual(state.effects, []);
  }
});

test("duplicate or contradictory requested associations cannot be rescued by one matching entry", async () => {
  for (const defect of ["duplicate", "head", "base", "source", "head-ref", "base-ref"]) {
    const { state, port } = fixture(); const run = runMetadata();
    const extra = structuredClone(run.pull_requests[0]!);
    if (defect === "head") { extra.head.sha = "c".repeat(40); }
    else if (defect === "base") { extra.base.sha = "c".repeat(40); }
    else if (defect === "source") { extra.head.repo.id = 23; }
    else if (defect === "head-ref") { extra.head.ref = "other"; }
    else if (defect === "base-ref") { extra.base.ref = "other"; }
    run.pull_requests.push(extra); state.runs = [run];
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested", defect);
    assert.equal(state.effects.length, 2, defect);
  }
});

test("an association without an optional base ref retains its exact SHA/source binding", async () => {
  const { state, port } = fixture(); state.runs = [runMetadata()]; const gh = port.gh;
  port.gh = async (args, timeout) => {
    const response = await gh(args, timeout);
    if (!args[1]?.includes("/actions/")) { return response; }
    // Omission in JSON matches the provider's older association shape.
    return response.replaceAll(`,"ref":"${baseRef}"`, "");
  };
  assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
  assert.deepEqual(state.effects, []);
});

// RED: a stale failed list conclusion used to re-request a fresh successful run;
// a stale success used to reject fresh failure instead of requesting new work.
test("fresh run detail decides reuse when list conclusions lag success or failure", async () => {
  for (const conclusion of ["success", "failure"]) {
    const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion }]; const gh = port.gh;
    port.gh = async (args, timeout) => {
      const response = await gh(args, timeout);
      if (args[1]?.includes("/workflows/ci.yml/runs?")) {
        return JSON.stringify({ workflow_runs: state.runs.map(run => run.id === 101
          ? { ...run, conclusion: conclusion === "success" ? "failure" : "success" } : run) });
      }
      return response;
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, conclusion === "success" ? "ready" : "requested");
    assert.equal(state.effects.length, conclusion === "success" ? 0 : 2);
    if (conclusion === "failure") { assert.equal(state.effects[1]![1], "rerun"); }
  }
});

// RED: a newly discovered run's cached list status used to decide whether to
// watch. Fresh detail can require a watch or already prove completion.
test("new request detail controls watching despite stale run-list completion", async () => {
  for (const needsWatch of [true, false]) {
    const { state, port } = fixture(); const gh = port.gh;
    const complete = () => {
      state.runs[0]!.status = "completed"; state.runs[0]!.conclusion = "success";
      for (const job of state.jobs) { job.run_id = 102; }
    };
    state.watch = complete;
    if (!needsWatch) { state.beforeReadRun = complete; }
    port.gh = async (args, timeout) => {
      const response = await gh(args, timeout);
      if (needsWatch && args[1]?.includes("/workflows/ci.yml/runs?")) {
        return JSON.stringify({ workflow_runs: state.runs.map(run => ({ ...run, status: "completed", conclusion: "success" })) });
      }
      return response;
    };
    assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
    assert.equal(state.waits.length, needsWatch ? 1 : 0);
    assert.equal(state.effects.length, 2);
  }
});

// RED: run-list identity remained unchanged while detail was requeued, failed or
// rerun after job discovery. Cached success must not become a ready verdict.
test("status, conclusion or attempt drift after jobs or latest discovery rejects readiness", async () => {
  for (const phase of ["jobs", "latest"]) {
    for (const field of ["status", "conclusion", "attempt"]) {
      const { state, port } = fixture(); state.runs = [runMetadata()]; const gh = port.gh;
      let jobReads = 0; let changed = false;
      port.gh = async (args, timeout) => {
        const response = await gh(args, timeout);
        if (args[1]?.includes("/jobs?")) { jobReads += 1; }
        const boundary = phase === "jobs" ? args[1]?.includes("/jobs?") : args[1]?.includes("/workflows/ci.yml/runs?");
        if (boundary && jobReads >= 2 && !changed) {
          changed = true;
          if (field === "status") { state.runs[0]!.status = "in_progress"; }
          else if (field === "conclusion") { state.runs[0]!.conclusion = "failure"; }
          else { state.runs[0]!.run_attempt += 1; }
        }
        return response;
      };
      await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /changed/u, `${phase}: ${field}`);
      assert.ok(changed, `${phase}: ${field} crossed the observation boundary`);
      assert.deepEqual(state.effects, []);
    }
  }
});

// RED: attempt-only jobs omit successful gates retained from earlier attempts
// after selective retry, so the old helper posted another full request.
test("selective retries qualify the latest effective gates across bounded job attempts", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), run_attempt: 3 }];
  state.jobs.forEach((job, index) => { job.run_attempt = [1, 2, 2, 3][index]!; });
  assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
  assert.deepEqual(state.effects, []);
  assert.ok(state.reads.some(args => args[1]?.includes("/actions/runs/101/jobs?filter=latest")));
  assert.ok(state.reads.every(args => !args[1]?.includes("/attempts/")));
});

// A historical success cannot mask a failed effective gate or make duplicate
// gate entries from different attempts safe to accept.
test("selective retries reject unsuccessful or ambiguous latest effective gate evidence", async () => {
  for (const defect of ["failure", "skipped", "neutral", "duplicate-attempt"]) {
    const { state, port } = fixture(); state.runs = [{ ...runMetadata(), run_attempt: 3 }];
    const gate = state.jobs.find(job => job.name === "check")!; gate.run_attempt = 3;
    if (defect === "duplicate-attempt") { state.jobs.push({ ...gate, id: 2001, run_attempt: 1 }); }
    else { gate.conclusion = defect; }
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /malformed gate evidence/u, defect);
    assert.deepEqual(state.effects, [], defect);
  }
});

test("truncated latest job discovery cannot reuse partial successful gates", async () => {
  const { state, port } = fixture(); state.runs = [runMetadata()];
  state.jobs.push(...Array.from({ length: 96 }, (_, index) => ({ ...state.jobs[0]!, id: 2001 + index, name: `producer-${index}` })));
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /300-entry bound/u);
  assert.deepEqual(state.effects, []);
});

test("the production port constructor gives concurrent callers distinct UUID ownership", async () => {
  const { state, port } = fixture();
  const first = createFullCiPort(port.gh); const second = createFullCiPort(port.gh);
  first.delay = port.delay; second.delay = port.delay;
  await Promise.all([requestFullPrCi(["--pr", "7"], first), requestFullPrCi(["--pr", "7"], second)]);
  const creations = state.effects.filter(args => args[3] === "repos/example/tooling/labels");
  assert.equal(creations.length, 2); assert.notEqual(creations[0]!.at(-1), creations[1]!.at(-1));
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 1); assert.equal(state.runs.length, 1);
});

test("concurrent lost creation and attachment acknowledgements still emit only one event", async () => {
  const { state, port } = fixture(); state.loseCreate = true; state.losePost = true;
  const results = await Promise.all([requestFullPrCi(["--pr", "7"], port), requestFullPrCi(["--pr", "7"], port)]);
  assert.equal(results[0]!.url, results[1]!.url);
  assert.equal(state.effects.filter(args => args[3] === "repos/example/tooling/labels").length, 2);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 1); assert.equal(state.runs.length, 1);
});

test("the deterministic reservation binds every canonical source field and excludes the caller nonce", async () => {
  async function nameFor(change: (state: FixtureState) => void, repoId = 11,
    repoName = "example/tooling", pr = 7, nonce = "00000000-0000-4000-8000-000000000001") {
    const { state, port } = fixture(); change(state); state.failCreate = true;
    state.pr.number = pr; state.pr.base.repo = { id: repoId, full_name: repoName };
    port.nonce = () => nonce;
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      const translated = args.map(arg => arg.replaceAll(repoName, "example/tooling").replace(`/pulls/${pr}`, "/pulls/7"));
      const response = await gh(translated, timeout);
      if (args[0] === "repo") { return JSON.stringify({ nameWithOwner: repoName }); }
      if (args[1] === `repos/${repoName}`) { return JSON.stringify({ id: repoId, full_name: repoName }); }
      return response;
    };
    await assert.rejects(requestFullPrCi(["--pr", String(pr)], port), /effect uncertain/u);
    assert.equal(state.effects.length, 1);
    return state.effects[0]!.find(arg => arg.startsWith("name="))!.slice(5);
  }
  const canonical = await nameFor(() => {});
  assert.equal(canonical, "ci:full:d280726194e4547d25b91c21a836ba1e533d2942");
  assert.equal(await nameFor(() => {}, 11, "example/tooling", 7, "00000000-0000-4000-8000-000000000002"), canonical);
  assert.equal(await nameFor(state => { state.pr.labels = [{ name: "ci:full" }]; }), canonical);
  const names = [canonical];
  for (const change of sourceChanges) { names.push(await nameFor(change)); }
  names.push(await nameFor(() => {}, 12), await nameFor(() => {}, 11, "example/other"), await nameFor(() => {}, 11, "example/tooling", 8));
  assert.equal(new Set(names).size, names.length);
});

test("reservation is independent of the global repository label inventory", async () => {
  const { state, port } = fixture();
  for (let i = 0; i < 400; i += 1) { state.labels.set(`unrelated-${i}`, { name: `unrelated-${i}`, description: "unrelated" }); }
  const gh = port.gh;
  port.gh = async (args, timeout) => {
    assert.ok(!args[1]?.startsWith("repos/example/tooling/labels?"), "global label enumeration is forbidden");
    return gh(args, timeout);
  };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.equal(state.labels.size, 401);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 1);
});

test("a lost creation response owned by another nonce cannot attach, even when a bound run appears", async () => {
  const { state, port } = fixture(); state.foreignCreate = true;
  state.afterCreate = () => { state.runs = [runMetadata()]; };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "ready");
  assert.equal(state.effects.length, 1);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
});

test("an orphaned reservation stays bounded and read-only without takeover or attachment", async () => {
  const { state, port } = fixture(); state.foreignCreate = true;
  for (let call = 0; call < 2; call += 1) {
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /reserved snapshot.*manually requesting ci:full/u);
  }
  assert.equal(state.labels.size, 1);
  assert.equal(state.effects.length, 2, "each invocation attempts creation once and never takes over");
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
  assert.equal(state.delays.filter(delay => delay === 5000).length, 22);
});

test("an unconfirmed creation fails closed after three exact reads and never repeats the write", async () => {
  const { state, port } = fixture(); state.failCreate = true;
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /Reservation creation effect uncertain/u);
  assert.equal(state.effects.length, 1);
  assert.equal(state.reads.filter(args => args[1]?.startsWith("repos/example/tooling/labels/")).length, 3);
  assert.deepEqual(state.delays, [250, 500]);
});

test("malformed reservation ownership is never authority to attach", async () => {
  for (const response of [{ name: "wrong", description: "other" }, { name: "ci:full:d280726194e4547d25b91c21a836ba1e533d2942" }]) {
    const { state, port } = fixture(); const gh = port.gh;
    port.gh = async (args, timeout) => args[1]?.startsWith("repos/example/tooling/labels/") ? JSON.stringify(response) : gh(args, timeout);
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /ownership malformed/u);
    assert.equal(state.effects.length, 1);
  }
});

test("non-User and malformed user identities reject all writes, while read-only reuse needs no user endpoint", async () => {
  for (const user of [{ type: "Bot", id: 31, login: "github-actions" }, { type: "User", id: 0, login: "operator" },
    { type: "User", id: 1.5, login: "operator" }, { type: "User", id: 31, login: "" }, { type: "User", id: 31, login: "bad/login" },
    { id: 31, login: "operator" }, { type: "User", login: "operator" }]) {
    const { state, port } = fixture(); const gh = port.gh;
    port.gh = async (args, timeout) => args[1] === "user" ? JSON.stringify(user) : gh(args, timeout);
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /user-authenticated/u);
    assert.deepEqual(state.effects, []);
  }
  for (const status of ["completed", "queued"]) {
    const { state, port } = fixture(); state.runs = [{ ...runMetadata(), status }]; const gh = port.gh;
    port.gh = async (args, timeout) => { assert.notEqual(args[1], "user"); return gh(args, timeout); };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, status === "completed" ? "ready" : "requested");
    assert.deepEqual(state.effects, []);
  }
});

test("malformed caller nonces reject before creation and reuse never allocates a nonce", async () => {
  for (const nonce of ["", "other", "a".repeat(101)]) {
    const { state, port } = fixture(); port.nonce = () => nonce;
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /owner UUID/u);
    assert.deepEqual(state.effects, []);
  }
  const { state, port } = fixture(); state.runs = [runMetadata()];
  port.nonce = () => { throw new Error("read-only reuse must not allocate ownership"); };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "ready");
});

test("head or source bindings changed during reservation prevent both attachment and failed-job rerun", async () => {
  for (const retry of [false, true]) {
    for (const change of sourceChanges) {
      const { state, port } = fixture();
      if (retry) { state.runs = [{ ...runMetadata(), conclusion: "failure" }]; }
      state.afterCreate = () => { change(state); };
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /head\/base changed/u);
      assert.equal(state.effects.length, 1, "only the reservation may have been created");
    }
  }
});

test("two concurrent helpers retry failed jobs once and qualify GitHub's cloned current-attempt job rows", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion: "failure" }];
  state.jobs[3]!.conclusion = "failure";
  state.watch = () => {
    state.runs[0]!.status = "completed"; state.runs[0]!.conclusion = "success";
    state.jobs[3]!.conclusion = "success";
  };
  const results = await Promise.all([requestFullPrCi(["--pr", "7", "--wait"], port), requestFullPrCi(["--pr", "7", "--wait"], port)]);
  assert.ok(results.every(result => result.outcome === "ready" && result.url === url));
  assert.equal(state.runs[0]!.run_attempt, 2);
  assert.ok(state.jobs.every(job => job.run_attempt === 2));
  assert.equal(state.effects.filter(args => args[1] === "rerun").length, 1);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
  assert.equal(state.labels.size, 1);
  assert.notEqual([...state.labels.keys()][0], "ci:full:d280726194e4547d25b91c21a836ba1e533d2942", "retry and request reservations differ");
  assert.deepEqual(state.pr.labels, []);
});

test("each unsuccessful completed run uses the explicit failed-job rerun command", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]) {
    const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion }];
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
    assert.deepEqual(state.effects[1], ["run", "rerun", "101", "--repo", "example/tooling", "--failed"]);
    assert.equal(state.effects.length, 2);
    assert.deepEqual(state.pr.labels, []);
  }
});

test("lost rerun acknowledgements reconcile delayed next attempts through reads only", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion: "failure" }];
  state.discoverRerun = false; state.loseRerun = true;
  port.delay = async milliseconds => {
    state.delays.push(milliseconds);
    if (state.delays.length === 2) {
      state.runs[0]!.run_attempt = 2; state.runs[0]!.status = "queued"; state.runs[0]!.conclusion = "";
    }
  };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.deepEqual(state.delays, [5000, 5000]);
  assert.equal(state.effects.filter(args => args[1] === "rerun").length, 1);
  assert.equal(state.effects.length, 2);
});

test("a rerun reservation with no next attempt fails boundedly and a second invocation cannot resubmit", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion: "failure" }];
  state.discoverRerun = false; state.loseRerun = true;
  for (let call = 0; call < 2; call += 1) {
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /Retry effect uncertain/u);
  }
  assert.equal(state.effects.filter(args => args[1] === "rerun").length, 1);
  assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
  assert.equal(state.delays.filter(delay => delay === 5000).length, 22);
});

test("a next attempt that appears during reservation is reused without another rerun", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion: "failure" }];
  state.afterCreate = () => {
    state.runs[0]!.run_attempt = 2; state.runs[0]!.status = "queued"; state.runs[0]!.conclusion = "";
  };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.equal(state.effects.length, 1);
});

test("rerun discovery tolerates a lagging list attempt through bounded reads", async () => {
  const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion: "failure" }];
  const gh = port.gh; let laggingReads = 0;
  port.gh = async (args, timeout) => {
    const response = await gh(args, timeout);
    if (args[1]?.includes("/workflows/ci.yml/runs?") && state.runs[0]!.run_attempt === 2 && ++laggingReads <= 3) {
      return JSON.stringify({ workflow_runs: [{ ...state.runs[0], run_attempt: 1 }] });
    }
    return response;
  };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.ok(state.delays.length > 0);
  assert.equal(state.effects.filter(args => args[1] === "rerun").length, 1);
});

test("retry attempts beyond the one authorized successor and newer requests reject instead of resubmitting", async () => {
  for (const phase of ["reservation", "rerun"]) {
    for (const drift of ["attempt", "request"]) {
      const { state, port } = fixture(); state.runs = [{ ...runMetadata(), conclusion: "failure" }];
      const change = () => {
        if (drift === "attempt") { state.runs[0]!.run_attempt = 3; }
        else { state.runs.push({ ...runMetadata(), id: 103, html_url: url.replace("101", "103") }); }
      };
      if (phase === "reservation") { state.afterCreate = change; }
      else {
        const gh = port.gh;
        port.gh = async (args, timeout) => { const response = await gh(args, timeout); if (args[1] === "rerun") { change(); } return response; };
      }
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /changed/u);
      assert.equal(state.effects.filter(args => args[1] === "rerun").length, phase === "rerun" ? 1 : 0);
      assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, 0);
    }
  }
});

test("watch stays pinned to the specific bound run and attempt for reuse, new requests and retries", async () => {
  for (const path of ["reuse", "request", "retry"]) {
    for (const drift of ["attempt", "request"]) {
      const { state, port } = fixture();
      if (path !== "request") { state.runs = [{ ...runMetadata(), status: path === "retry" ? "completed" : "queued", conclusion: "failure" }]; }
      state.watch = () => {
        const current = state.runs[0]!;
        if (drift === "attempt") { current.run_attempt += 1; }
        else { state.runs.push({ ...runMetadata(), id: 103, html_url: url.replace("101", "103") }); }
      };
      await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /changed/u, `${path}: ${drift}`);
      assert.equal(state.waits.length, 1);
      assert.equal(state.effects.filter(args => args[1] === "rerun").length, path === "retry" ? 1 : 0);
      assert.equal(state.effects.filter(args => args[3]?.includes("/issues/")).length, path === "request" ? 1 : 0);
    }
  }
});

test("retry reservations bind both the failed run ID and its current attempt", async () => {
  const names: string[] = [];
  for (const [id, attempt] of [[101, 1], [102, 1], [101, 2]]) {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), id: id!, html_url: url.replace("101", String(id)), run_attempt: attempt!, conclusion: "failure" }];
    await requestFullPrCi(["--pr", "7"], port);
    names.push([...state.labels.keys()][0]!);
  }
  assert.equal(new Set(names).size, 3);
});

test("the gate inspection API is read-only for ready, pending, failed, malformed and absent evidence", async () => {
  for (const scenario of ["ready", "pending", "failed", "malformed", "absent"]) {
    const { state, port } = fixture(); const gh = port.gh;
    if (scenario !== "absent") { state.runs = [runMetadata()]; }
    if (scenario === "pending") { state.runs[0]!.status = "queued"; state.runs[0]!.conclusion = ""; }
    if (scenario === "failed") { state.runs[0]!.conclusion = "failure"; }
    if (scenario === "malformed") { state.jobs[0]!.conclusion = "skipped"; }
    port.nonce = () => { throw new Error("inspection must never allocate reservation ownership"); };
    port.gh = async (args, timeout) => { assert.notEqual(args[1], "user"); return gh(args, timeout); };
    if (scenario === "ready" || scenario === "pending") {
      assert.equal((await readFullPrCi(["--pr", "7"], port)).outcome, scenario === "ready" ? "ready" : "requested");
    } else {
      await assert.rejects(readFullPrCi(["--pr", "7"], port), /not successful|No exact bound/u);
    }
    assert.deepEqual(state.effects, []);
  }
  const { state, port } = fixture();
  await assert.rejects(readFullPrCi(["--pr", "0"], port), /Usage/u);
  assert.deepEqual(state.reads, []);
});
