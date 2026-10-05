import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { createMergeOperatorPort, mergeCommandEnvironment, mergeReviewedPr, nativeMergeProfile, parseMergeArguments, readMergeReviewInput, renderMergeReviewPrompt, verifyReviewedPr } from "../scripts/merge-reviewed-pr.mts";
import type { MergeBinding, MergeCommand, MergePort } from "../scripts/merge-reviewed-pr.mts";

const head = "a".repeat(40); const base = "b".repeat(40); const workflowBlob = "c".repeat(40); const merged = "d".repeat(40);
const repository = "agent-teams-ai/engineering-foundation"; const repositoryId = 1316243988;
const registry = "/srv/worker-state/jobs/engineering-foundation/hardening-20261001/registry";
const jobRoots = "/srv/worker-state/jobs/engineering-foundation/hardening-20261001/jobs";
const workspaces = "/srv/workers/jobs/engineering-foundation/hardening-20261001/workspaces";
const job = "ef-independent-review";
const bodyFile = process.platform === "win32" ? "C:\\operator\\body.txt" : "/operator/body.txt";
const binding: MergeBinding = { repository, repositoryId, pr: 7, head, baseRef: "main", base,
  sourceRepositoryId: repositoryId, sourceRepository: repository, sourceRef: "ci/edge", workflowId: 55, workflowBlobSha: workflowBlob };
const diff = "diff --git a/scripts/operator.mts b/scripts/operator.mts\n+independent source\n";
const args = ["--pr", "7", "--review-job", job, "--review-host", "workers-fsn1-01", "--review-registry", registry,
  "--expected-head", head, "--expected-base-ref", "main", "--expected-base", base,
  "--subject", "ci: bound owner merge", "--body-file", bodyFile];
// Independent oracle: the owner-provided immutable inventory, not production's exported list.
const lanes = ["dependency-review", "windows-static", "linux-static", "linux-registry", "windows-test-a", "linux-bootstrap-evidence",
  "linux-published", "linux-tests-1-2", "node-compatibility (node26-compatibility)", "node-compatibility (node24-production-default)",
  "linux-tests-3-4", "linux-tests-7-8", "linux-tests-5-6", "windows-test-d", "windows-test-b", "macos-native", "macos-package (pnpm-docs)",
  "windows-published", "macos-package (npm-docs)", "windows-test-e", "macos-package (foundation)", "windows-test-c", "windows-registry (pnpm-docs)",
  "windows-package (integration)", "windows-registry (foundation)", "windows-registry (npm-docs)", "windows-package (quality-coverage)",
  "windows-package (sdk-growth)", "linux-package", "macos-qualification", "linux-coverage", "check", "windows-check", "full-ci"];
const verdict = { verdict: "PASS", repositoryId, pr: 7, head, baseRef: "main", base, workflowBlobSha: workflowBlob, findings: [] };
function fixture() {
  const pr = { number: 7, state: "open", merged: false, merge_commit_sha: merged,
    head: { sha: head, ref: "ci/edge", repo: { id: repositoryId, full_name: repository } },
    base: { sha: base, ref: "main", repo: { id: repositoryId, full_name: repository } } };
  const run = { id: 101, run_attempt: 2, workflow_id: 55, path: ".github/workflows/ci.yml", event: "pull_request",
    name: `Full CI #7 @${head} on ${base}`, display_title: `Full CI #7 @${head} on ${base}`,
    head_sha: head, head_branch: "ci/edge", repository: { id: repositoryId, full_name: repository },
    head_repository: { id: repositoryId, full_name: repository }, status: "completed", conclusion: "success",
    pull_requests: [{ number: 7, head: structuredClone(pr.head), base: structuredClone(pr.base) }] };
  const custody = { manifest: { jobId: job, taskId: job, jobRootDir: `${jobRoots}/${job}`, promptPath: `${jobRoots}/${job}/prompt.md`,
    workspacePath: `${workspaces}/${job}`, model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default" },
    prompt: renderMergeReviewPrompt(binding, diff), sourceTreeVerified: true, machineId: "d856d40da5ad4e23b4f67773e5942842",
    receipt: { status: "done", provider: "codex", taskId: job, runId: job, blockers: [] as string[], changedFiles: [] as string[],
      details: { baseCommit: head }, evidence: [`output_summary:${JSON.stringify(verdict)}`] } };
  interface Job { id: number; name: string; run_id: number; run_attempt?: number; head_sha: string; status: string; conclusion: string }
  const state = { pr, run, custody, workflow: { id: 55, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
    repository: { id: repositoryId, full_name: repository }, workflowBlob, diff,
    runs: [run], jobs: lanes.map((name, i): Job => ({ id: i + 1, name, run_id: 101, run_attempt: 2, head_sha: head, status: "completed", conclusion: "success" })),
    calls: [] as string[][], reviewCalls: 0, merges: 0, parents: [base],
    beforeRead: (_endpoint: string) => {}, duringReview: () => {}, duringMerge: () => {} };
  const port: MergePort = {
    async gh(command) {
      state.calls.push([...command]);
      if (command[0] === "pr") { assert.deepEqual(command, ["pr", "diff", "7", "--repo", repository]); return state.diff; }
      assert.deepEqual(command.slice(0, 6), ["api", "--hostname", "github.com", "--method", "GET", command[5]]);
      const endpoint = command[5]!; state.beforeRead(endpoint);
      if (endpoint === `repos/${repository}`) { return JSON.stringify(state.repository); }
      if (endpoint.endsWith("/pulls/7")) { return JSON.stringify(state.pr); }
      if (endpoint.endsWith("/actions/workflows/ci.yml")) { return JSON.stringify(state.workflow); }
      if (endpoint.includes("/contents/")) { return JSON.stringify({ path: ".github/workflows/ci.yml", type: "file", sha: state.workflowBlob }); }
      if (endpoint.includes("/workflows/ci.yml/runs?")) { return JSON.stringify({ workflow_runs: state.runs }); }
      if (endpoint.includes("/attempts/2/jobs?")) { return JSON.stringify({ jobs: state.jobs }); }
      if (endpoint.endsWith("/actions/runs/101")) { return JSON.stringify(state.run); }
      if (endpoint.endsWith(`/commits/${merged}`)) { return JSON.stringify({ sha: merged, parents: state.parents.map(sha => ({ sha })) }); }
      throw new Error(`Unexpected read: ${endpoint}`);
    },
    async review(options) { assert.equal(options.reviewJob, job); state.reviewCalls += 1; state.duringReview(); return state.custody; },
    async canonicalOwnerMerge(actual, options) {
      assert.deepEqual(actual, binding); assert.equal(options.subject, "ci: bound owner merge");
      state.merges += 1; state.pr.state = "closed"; state.pr.merged = true; state.duringMerge();
    },
  };
  return { state, port };
}
test("complete independent custody and all 34 native lanes admit only the canonical owner port", async () => {
  const { state, port } = fixture();
  assert.deepEqual(await verifyReviewedPr(args, port), binding); assert.equal(state.merges, 0);
  assert.deepEqual(nativeMergeProfile.jobs.toSorted(), lanes.toSorted());
  assert.equal(await mergeReviewedPr(args, port), merged); assert.equal(state.merges, 1);
  assert.ok(state.calls.some(call => call[5]?.includes("/attempts/2/jobs")));
});
test("operator prompt construction uses current exact source metadata and performs no reviewer lookup", async () => {
  const { state, port } = fixture(); const input = await readMergeReviewInput(args, port);
  assert.deepEqual(input.binding, binding); assert.equal(input.diff, diff); assert.equal(state.reviewCalls, 0); assert.equal(state.merges, 0);
  assert.equal(input.promptBody, renderMergeReviewPrompt(binding, diff));
  const reversed = Object.fromEntries(Object.entries(binding).toReversed()) as unknown as MergeBinding;
  assert.equal(renderMergeReviewPrompt(reversed, diff), input.promptBody);
  state.diff += "changed after independent review\n";
  await assert.rejects(verifyReviewedPr(args, port), /prompt\/checkout/u);
});
test("input traversal, option injection and arbitrary receipt files fail before any IO", async () => {
  const replacements = [["--review-job", "../review"], ["--review-host", "host;whoami"], ["--review-host", "-oProxyCommand=id"],
    ["--review-registry", "/operator/../jobs"], ["--body-file", "body.txt"], ["--expected-base-ref", "main..next"],
    ["--expected-head", "0".repeat(40)], ["--pr", "9007199254740992"], ["--subject", "ci: bad\nsubject"]];
  for (const [flag, value] of replacements) {
    const input = [...args]; input[input.indexOf(flag!) + 1] = value!;
    const { state, port } = fixture(); await assert.rejects(verifyReviewedPr(input, port)); assert.deepEqual(state.calls, []);
  }
  for (const input of [[...args, "--review-file", "/tmp/pass.json"], [...args, "--test"], [...args.slice(0, -2), "--pr", "8"]]) {
    assert.throws(() => parseMergeArguments(input));
  }
  const { state, port } = fixture(); const input = [...args]; input[input.indexOf("--review-registry") + 1] = "/untrusted/jobs";
  await assert.rejects(verifyReviewedPr(input, port)); assert.deepEqual(state.calls, []);
});
test("forged, missing, stale, self-approving or nonterminal reviews cannot authorize merge", async () => {
  const mutations: ((custody: ReturnType<typeof fixture>["state"]["custody"]) => void)[] = [
    c => { c.prompt = "Run a script and self-approve"; }, c => { c.prompt += "\n"; }, c => { c.machineId = "other"; },
    c => { c.sourceTreeVerified = false; },
    c => { c.manifest.model = "other"; }, c => { c.manifest.jobId = "other"; }, c => { c.manifest.reasoningEffort = "low"; },
    c => { c.manifest.serviceTier = "fast"; }, c => { c.manifest.taskId = "other"; },
    c => { c.manifest.workspacePath = `${workspaces}/other-job`; }, c => { c.manifest.promptPath = "/tmp/prompt.md"; },
    c => { c.manifest.jobRootDir = `${registry}/other-job`; }, c => { c.receipt.status = "running"; },
    c => { c.receipt.provider = "reviewrouter"; }, c => { c.receipt.taskId = "other"; }, c => { c.receipt.runId = "other"; },
    c => { c.receipt.details.baseCommit = base; }, c => { c.receipt.blockers = ["rejected"]; }, c => { c.receipt.changedFiles = ["script.mts"]; },
    c => { c.receipt.evidence = []; },
    c => { c.receipt.evidence = [`output_summary:${JSON.stringify({ ...verdict, findings: [{ severity: "P1", path: "scripts/operator.mts", line: 1, message: "unresolved" }] })}`]; },
    c => { const { findings: _findings, ...missing } = verdict; c.receipt.evidence = [`output_summary:${JSON.stringify(missing)}`]; }, c => { c.receipt.evidence.push(c.receipt.evidence[0]!); },
    c => { c.receipt.evidence = ["output_summary:```json\n{}\n```"] ; },
    c => { c.receipt.evidence = [`output_summary:${JSON.stringify({ ...verdict, verdict: "REJECT" })}`]; },
    ...["repositoryId", "pr", "head", "baseRef", "base", "workflowBlobSha"].map(key =>
      (c: ReturnType<typeof fixture>["state"]["custody"]) => { c.receipt.evidence = [`output_summary:${JSON.stringify({ ...verdict, [key]: "forged" })}`]; }),
  ];
  for (const change of mutations) {
    const { state, port } = fixture(); change(state.custody); await assert.rejects(mergeReviewedPr(args, port)); assert.equal(state.merges, 0);
  }
  const { state, port } = fixture(); port.review = async () => { throw new Error("missing hosted job"); };
  await assert.rejects(mergeReviewedPr(args, port)); assert.equal(state.merges, 0);
});
test("four spoofable successful aggregate aliases cannot substitute for the native matrix", async () => {
  const { state, port } = fixture(); state.jobs = state.jobs.filter(lane => ["full-ci", "check", "windows-check", "macos-qualification"].includes(lane.name));
  await assert.rejects(mergeReviewedPr(args, port), /Native CI lane/u); assert.equal(state.merges, 0);
});
test("every native lane rejects omission, duplicate, skip, neutral, stale head/run and historical attempt", async () => {
  for (const name of lanes) {
    for (const fault of ["missing", "duplicate", "skipped", "neutral", "failed", "pending", "head", "run", "attempt"]) {
      const { state, port } = fixture(); const lane = state.jobs.find(record => record.name === name)!;
      if (fault === "missing") { state.jobs = state.jobs.filter(record => record !== lane); }
      else if (fault === "duplicate") { state.jobs.push({ ...lane, id: 999 }); }
      else if (fault === "head") { lane.head_sha = base; }
      else if (fault === "run") { lane.run_id = 99; }
      else if (fault === "attempt") { lane.run_attempt = 1; }
      else if (fault === "pending") { lane.status = "in_progress"; }
      else { lane.conclusion = fault; }
      await assert.rejects(verifyReviewedPr(args, port), /Native CI|Duplicate CI/u); assert.equal(state.merges, 0);
    }
  }
  // GitHub current-attempt inherited clones are admitted when all metadata is current.
  const { state, port } = fixture(); state.jobs = state.jobs.map(record => ({ ...record, id: record.id + 1000 }));
  assert.deepEqual(await verifyReviewedPr(args, port), binding);
});
test("canonical run identity, event source/ref, base ref and workflow bytes stay bound", async () => {
  const mutations: ((s: ReturnType<typeof fixture>["state"]) => void)[] = [
    s => { s.repository.id = 1; }, s => { s.workflow.path = ".github/workflows/fake.yml"; },
    s => { s.run.workflow_id = 99; }, s => { s.run.path = ".github/workflows/fake.yml"; },
    s => { s.run.event = "push"; }, s => { s.run.name = "CI"; }, s => { s.run.display_title = "CI"; },
    s => { s.run.head_sha = base; }, s => { s.run.head_branch = "other"; }, s => { s.run.head_repository.id = 1; },
    s => { s.run.pull_requests[0]!.base.ref = "release"; }, s => { s.run.pull_requests[0]!.head.repo.id = 1; },
    s => { s.run.pull_requests = []; }, s => { s.workflowBlob = head; },
  ];
  for (const change of mutations) { const { state, port } = fixture(); change(state); await assert.rejects(mergeReviewedPr(args, port)); assert.equal(state.merges, 0); }
});
test("PR changes around diff, custody, gate discovery and the final ready read reject before canonical merge", async () => {
  for (const field of ["head", "base", "baseRef", "sourceRef", "sourceRepo"]) {
    for (const phase of ["diff", "custody", "discovery", "ready"]) {
      const { state, port } = fixture(); let reads = 0;
      const change = () => {
        if (field === "head") { state.pr.head.sha = base; }
        if (field === "base") { state.pr.base.sha = head; }
        if (field === "baseRef") { state.pr.base.ref = "release"; }
        if (field === "sourceRef") { state.pr.head.ref = "other"; }
        if (field === "sourceRepo") { state.pr.head.repo.id = 1; }
      };
      state.beforeRead = endpoint => {
        if (endpoint.endsWith("/pulls/7")) { reads += 1; if ((phase === "diff" && reads === 3) || (phase === "ready" && reads === 6)) { change(); } }
        if (phase === "discovery" && endpoint.includes("/workflows/ci.yml/runs?")) { change(); }
      };
      if (phase === "custody") { state.duringReview = change; }
      await assert.rejects(mergeReviewedPr(args, port)); assert.equal(state.merges, 0);
    }
  }
});
test("run attempts, status and newest request changing during jobs never admit historical success", async () => {
  for (const fault of ["attempt", "id", "status", "conclusion", "latest"]) {
    const { state, port } = fixture();
    state.beforeRead = endpoint => { if (endpoint.includes("/jobs?")) {
      if (fault === "attempt") { state.run.run_attempt = 3; }
      if (fault === "id") { state.run.id = 102; }
      if (fault === "status") { state.run.status = "in_progress"; }
      if (fault === "conclusion") { state.run.conclusion = "failure"; }
      if (fault === "latest") { state.runs.push({ ...state.run, id: 102 }); }
    } };
    await assert.rejects(mergeReviewedPr(args, port)); assert.equal(state.merges, 0);
  }
});
test("canonical merge is never retried; postmerge retarget or moved base reports uncertain completion", async () => {
  for (const fault of ["throw", "retarget", "baseMoved", "head"]) {
    const { state, port } = fixture(); state.duringMerge = () => {
      if (fault === "throw") { throw new Error("lost canonical response"); }
      if (fault === "retarget") { state.pr.base.ref = "release"; }
      if (fault === "baseMoved") { state.parents = [head]; }
      if (fault === "head") { state.pr.head.sha = base; }
    };
    await assert.rejects(mergeReviewedPr(args, port)); assert.equal(state.merges, 1);
  }
});
test("unadmitted review hosts reject before SSH or GitHub IO", async () => {
  let calls = 0;
  const run: MergeCommand = async () => { calls += 1; throw new Error("unexpected IO"); };
  await assert.rejects(createMergeOperatorPort(run).review({ ...parseMergeArguments(args), reviewHost: "attacker" }, binding));
  assert.equal(calls, 0);
});
test("canonical adapter fetches both pinned files outside candidate and uses only supported guard flags", async () => {
  for (const fault of ["none", "blob", "retarget", "push"]) {
    const { state, port } = fixture(); const calls: { executable: string; argv: readonly string[] }[] = []; let guardPath = "";
    const bytes = new Map([["scripts/merge-owner-pr.mjs", "// canonical guard fixture\n"], ["governance/commit-author-identity.json", "{}\n"]]);
    const run: MergeCommand = async (executable, argv, _input, cwd) => {
      calls.push({ executable, argv });
      if (executable === "gh" && argv[5]?.includes("/contents/")) {
        const file = argv[5].split("/contents/")[1]!.split("?")[0]!; const content = Buffer.from(bytes.get(file)!);
        assert.equal(argv[5], `repos/agent-teams-ai/.github/contents/${file}?ref=05b30bcc00cdf07cfde9ba60a1136bb9df7f7571`);
        if (fault === "retarget") { state.pr.base.ref = "release"; }
        if (fault === "push") { state.pr.head.sha = base; }
        const blobSha = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
        return JSON.stringify({ path: file, encoding: "base64", content: content.toString("base64"), sha: fault === "blob" ? head : blobSha });
      }
      if (executable === "gh") { return port.gh(argv); }
      assert.equal(executable, process.execPath); assert.ok(cwd); assert.equal(cwd.startsWith(`${workspaces}/`), false);
      guardPath = argv[0]!; assert.equal(await readFile(guardPath, "utf8"), bytes.get("scripts/merge-owner-pr.mjs"));
      assert.equal(await readFile(join(cwd, "governance/commit-author-identity.json"), "utf8"), bytes.get("governance/commit-author-identity.json"));
      assert.deepEqual(argv.slice(1), ["--repository", repository, "--pr", "7", "--expected-head", head,
        "--subject", "ci: bound owner merge", "--body-file", bodyFile]);
      assert.ok(calls.at(-2)!.argv[5]?.endsWith("/pulls/7")); return "{}";
    };
    const operation = createMergeOperatorPort(run).canonicalOwnerMerge(binding, parseMergeArguments(args));
    if (fault === "none") { await operation; assert.notEqual(guardPath, ""); await assert.rejects(readFile(guardPath)); }
    else { await assert.rejects(operation); assert.equal(guardPath, ""); }
    assert.equal(calls.some(call => call.executable === "gh" && call.argv[0] === "pr"), false);
  }
});
test("unrelated PR associations and failed advisory do not invalidate mandatory successful lanes", async () => {
  const { state, port } = fixture();
  state.run.pull_requests.unshift({ ...structuredClone(state.run.pull_requests[0]!), number: 99 });
  delete (state.run.pull_requests[1]!.base as { ref?: string }).ref;
  state.jobs.push({ id: 500, name: "advisory-shadow-classifier", run_id: 101, head_sha: head, status: "completed", conclusion: "failure" });
  assert.deepEqual(await verifyReviewedPr(args, port), binding);
  state.run.pull_requests.push(structuredClone(state.run.pull_requests[1]!));
  await assert.rejects(verifyReviewedPr(args, port));
});
test("guard subprocesses remove module injection and candidate command search paths", () => {
  const input = { NODE_OPTIONS: "--import /candidate/inject.mts", NODE_PATH: "/candidate/node_modules", PATH: "/candidate/node_modules/.bin", GH_TOKEN: "authorized-test-token" };
  const env = mergeCommandEnvironment(input);
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.PATH?.includes("/candidate"), false); assert.equal(env.GH_TOKEN, input.GH_TOKEN);
  assert.equal(input.NODE_OPTIONS, "--import /candidate/inject.mts");
});
