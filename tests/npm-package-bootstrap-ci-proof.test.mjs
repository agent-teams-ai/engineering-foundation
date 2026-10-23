import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import test from "node:test";

import {
  CI_CONTEXTS,
  CI_PROOF_CONTEXTS,
  CI_WORKFLOW_PATH,
  CiProofError,
  githubRequest,
  proveCommitCi,
} from "../scripts/npm-package-bootstrap-ci-proof.mjs";

const repository = "agent-teams-ai/engineering-foundation";
const commit = "a".repeat(40);
const run = {
  id: 77,
  run_attempt: 1,
  head_sha: commit,
  event: "push",
  head_branch: "main",
  path: CI_WORKFLOW_PATH,
  status: "completed",
  conclusion: "success",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const job = (name, more = {}) => ({
  name,
  run_id: 77,
  run_attempt: 1,
  head_sha: commit,
  status: "completed",
  conclusion: "success",
  ...more,
});
const jobs = () => CI_PROOF_CONTEXTS.map((name) => job(name));

function api({ runs = [run], items = jobs() } = {}) {
  const requested = [];
  const request = async (path) => {
    requested.push(path);
    if (path.includes("/workflows/ci.yml/runs?")) {
      return { total_count: runs.length, workflow_runs: runs };
    }
    if (path.includes("/runs/77/jobs?")) {
      return { total_count: items.length, jobs: items };
    }
    throw new Error(`unexpected request ${path}`);
  };
  return { request, requested };
}
const refused = (input, code) =>
  assert.rejects(proveCommitCi({ repository, commit, ...input }), (error) => {
    assert.ok(error instanceof CiProofError);
    assert.equal(error.code, code);
    return true;
  });

test("a green push run of ci.yml on main for the exact commit is the proof", async () => {
  const { request, requested } = api();
  assert.deepEqual(await proveCommitCi({ repository, commit, request }), {
    runId: 77,
    commit,
    contexts: CI_PROOF_CONTEXTS,
  });
  // Only the two Actions run endpoints are read: a check run from another app can never enter the proof.
  assert.deepEqual(requested, [
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&branch=main&per_page=100`,
    `repos/${repository}/actions/runs/77/jobs?filter=latest&per_page=100`,
  ]);
});

test("no run, a foreign SHA, another event, branch or workflow, or a duplicate is refused", async () => {
  await refused(api({ runs: [] }), "CI_PROOF_NO_RUN");
  for (const change of [
    { head_sha: "b".repeat(40) },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { event: "merge_group" },
    { head_branch: "release" },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "someone/fork" } },
    { head_repository: { full_name: "someone/fork" } },
  ]) {
    await refused(api({ runs: [{ ...run, ...change }] }), "CI_PROOF_NO_RUN");
  }
  await refused(api({ runs: [run, { ...run, id: 78 }] }), "CI_PROOF_AMBIGUOUS");
});

test("a running or not green run is refused without waiting", async () => {
  await refused(
    api({ runs: [{ ...run, status: "in_progress", conclusion: null }] }),
    "CI_PROOF_PENDING",
  );
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    await refused(api({ runs: [{ ...run, conclusion }] }), "CI_PROOF_NOT_GREEN");
  }
});

test("every required context must be a single successful job of that run", async () => {
  for (const context of CI_PROOF_CONTEXTS) {
    await refused(
      api({ items: jobs().filter(({ name }) => name !== context) }),
      "CI_PROOF_CONTEXT_MISSING",
    );
    await refused(
      api({
        items: jobs().map((item) =>
          item.name === context ? { ...item, conclusion: "failure" } : item,
        ),
      }),
      "CI_PROOF_CONTEXT_NOT_SUCCESS",
    );
    await refused(
      api({
        items: jobs().map((item) =>
          item.name === context ? { ...item, status: "in_progress", conclusion: null } : item,
        ),
      }),
      "CI_PROOF_CONTEXT_NOT_SUCCESS",
    );
    await refused(api({ items: [...jobs(), job(context)] }), "CI_PROOF_AMBIGUOUS");
  }
  await refused(
    api({
      items: jobs().map((item, index) =>
        index === 0 ? { ...item, head_sha: "b".repeat(40) } : item,
      ),
    }),
    "CI_PROOF_MALFORMED",
  );
  await refused(
    api({ items: jobs().map((item, index) => (index === 0 ? { ...item, run_id: 5 } : item)) }),
    "CI_PROOF_MALFORMED",
  );
  // A job of another attempt of the same run does not prove the attempt that was selected.
  await refused(
    api({ items: jobs().map((item, index) => (index === 0 ? { ...item, run_attempt: 2 } : item)) }),
    "CI_PROOF_MALFORMED",
  );
});

test("a same-named check run from another app does not count", async () => {
  // The foreign check runs exist on the commit, but they are not jobs of the Actions run, so the real job is still missing.
  const { request, requested } = api({ items: jobs().filter(({ name }) => name !== "full-ci") });
  const withForeign = async (path) =>
    path.includes("/check-runs")
      ? { check_runs: [{ name: "full-ci", conclusion: "success", app: { slug: "other" } }] }
      : request(path);
  await assert.rejects(proveCommitCi({ repository, commit, request: withForeign }), {
    code: "CI_PROOF_CONTEXT_MISSING",
  });
  assert.equal(
    requested.some((path) => path.includes("check-runs")),
    false,
  );
});

test("malformed input and incomplete listings fail closed", async () => {
  await refused({ commit: "abc", request: api().request }, "CI_PROOF_INPUT");
  await refused({ request: async () => ({}) }, "CI_PROOF_MALFORMED");
  await refused(
    {
      request: async (path) =>
        path.includes("/jobs?")
          ? { total_count: 999, jobs: jobs() }
          : { total_count: 1, workflow_runs: [run] },
    },
    "CI_PROOF_MALFORMED",
  );
  await refused(
    { request: async () => ({ total_count: 150, workflow_runs: [run] }) },
    "CI_PROOF_MALFORMED",
  );
  await refused(
    api({ items: Array.from({ length: 101 }, (_, index) => job(`job-${String(index)}`)) }),
    "CI_PROOF_MALFORMED",
  );
  await assert.rejects(
    proveCommitCi({ repository: "bad repository", commit, request: api().request }),
    { code: "CI_PROOF_INPUT" },
  );
});

test("the GitHub request helper sends the token only to the API host and refuses an error status", async () => {
  const calls = [];
  const ok = githubRequest("token-value", async (url, init) => {
    calls.push([url, init.headers.authorization, init.redirect]);
    return { ok: true, json: async () => ({ fine: true }) };
  });
  assert.deepEqual(await ok("repos/a/b/actions/runs/1/jobs?per_page=100"), { fine: true });
  assert.deepEqual(calls, [
    [
      "https://api.github.com/repos/a/b/actions/runs/1/jobs?per_page=100",
      "Bearer token-value",
      "error",
    ],
  ]);
  const bad = githubRequest("token-value", async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
  }));
  await assert.rejects(bad("repos/a/b/x?y=1"), { code: "CI_PROOF_API" });
});

test("the proof contexts are the release attestation contexts", async () => {
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(release, new RegExp(`ci_contexts=\\(${CI_CONTEXTS.join(" ")}\\)`, "u"));
  assert.deepEqual(CI_PROOF_CONTEXTS.slice(0, CI_CONTEXTS.length), CI_CONTEXTS);
  assert.equal(CI_PROOF_CONTEXTS.at(-1), "linux-package");
});

test("the command always runs: through a symlinked path, and not at all as a side effect of importing the library", async () => {
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = await mkdtemp(join(tmpdir(), "ci-proof-link-"));
  try {
    const link = join(directory, "proof.mjs");
    await symlink(
      fileURLToPath(new URL("../scripts/npm-package-bootstrap-ci-proof-cli.mjs", import.meta.url)),
      link,
    );
    const env = { ...process.env };
    delete env.GH_TOKEN;
    const result = spawnSync(process.execPath, [link, commit], { encoding: "utf8", env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI_PROOF_INPUT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // Importing the library must neither run the proof nor change the exit code.
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import(process.argv[1]);",
      new URL("../scripts/npm-package-bootstrap-ci-proof.mjs", import.meta.url).href,
    ],
    { encoding: "utf8" },
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stderr, "");
});

test("ci.yml really has one job for every proof context on a push to main", async () => {
  const ci = parseYaml(
    await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.ok(Object.keys(ci.on).includes("push"));
  assert.ok(ci.on.push.branches.includes("main"));
  for (const context of CI_PROOF_CONTEXTS) {
    // A name is a literal or an expression whose push branch is the context, such as `... && 'check' || 'ci-not-requested'`.
    const named = Object.values(ci.jobs).filter(
      ({ name }) =>
        name === context || (typeof name === "string" && name.includes(`&& '${context}' ||`)),
    );
    assert.equal(named.length, 1, context);
    const [definition] = named;
    // The job must be able to run on a push: no condition, or one that admits any event but a pull request or is always true.
    assert.ok(
      definition.if === undefined ||
        /github\.event_name != 'pull_request'|always\(\)/u.test(String(definition.if)),
      `${context} runs on push`,
    );
  }
});
