import assert from "node:assert/strict";
import type { FullCiPort } from "../scripts/request-full-pr-ci.mts";

export const head = "a".repeat(40);
export const base = "b".repeat(40);
export const baseRef = "main";
export const url = "https://github.com/example/tooling/actions/runs/101";
const prMetadata = {
  number: 7,
  state: "open",
  labels: [] as { name: string }[],
  head: { sha: head, ref: "test/fork-pr", repo: { id: 22, full_name: "fork/tooling" } },
  base: { sha: base, ref: baseRef, repo: { id: 11, full_name: "example/tooling" } },
};
export function runMetadata() {
  // Shape observed by root in TEST run 37226486275: both names carry run-name;
  // workflow_id identifies the workflow. Repository/PR values are fixture-local.
  return {
    id: 101,
    run_attempt: 1,
    workflow_id: 55,
    name: `Full CI #7 @${head} on ${base}`,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: head,
    head_branch: "test/fork-pr",
    display_title: `Full CI #7 @${head} on ${base}`,
    repository: { id: 11, full_name: "example/tooling" },
    html_url: url,
    head_repository: { id: 22, full_name: "fork/tooling" },
    status: "completed",
    conclusion: "success",
    pull_requests: [
      {
        number: 7,
        head: { sha: head, ref: "test/fork-pr", repo: { id: 22 } },
        base: { sha: base, ref: baseRef, repo: { id: 11 } },
      },
    ],
  };
}
export interface JobMetadata {
  id?: number;
  run_id: number;
  run_attempt?: number;
  head_sha?: string;
  name: string;
  status: string;
  conclusion: string;
}
export function fixture() {
  const pr = structuredClone(prMetadata);
  const state = {
    pr,
    runs: [] as ReturnType<typeof runMetadata>[],
    workflow: { id: 55, name: "CI", path: ".github/workflows/ci.yml" },
    jobs: ["full-ci", "check", "windows-check", "macos-qualification"].map(
      (name, index): JobMetadata => ({
        id: 1001 + index,
        run_id: 101,
        run_attempt: 1,
        head_sha: head,
        name,
        status: "completed",
        conclusion: "success",
      }),
    ),
    effects: [] as string[][],
    reads: [] as string[][],
    waits: [] as number[],
    labels: new Map<string, { name: string; description: string }>(),
    user: { type: "User", id: 31, login: "operator" },
    discover: true,
    losePost: false,
    loseCreate: false,
    failCreate: false,
    foreignCreate: false,
    discoverRerun: true,
    loseRerun: false,
    delays: [] as number[],
    watch: () => {},
    beforePost: () => {},
    beforeReadRun: () => {},
    afterCreate: () => {},
  };
  function rerunFailed(args: readonly string[]): string {
    state.effects.push([...args]);
    assert.deepEqual(args, ["run", "rerun", args[2], "--repo", "example/tooling", "--failed"]);
    if (state.discoverRerun) {
      const run = state.runs.find((entry) => String(entry.id) === args[2])!;
      run.run_attempt += 1;
      run.status = "queued";
      run.conclusion = "";
      // GitHub's latest jobs response clones carried successful jobs into
      // the new attempt. This is not a union of historical job responses.
      for (const job of state.jobs) {
        job.run_attempt = run.run_attempt;
        job.run_id = run.id;
      }
    }
    if (state.loseRerun) {
      throw new Error("rerun response lost");
    }
    return "";
  }
  const port: FullCiPort = {
    async gh(args, timeout) {
      const command = [...args];
      state.reads.push(command);
      assert.equal(timeout, args[1] === "watch" ? 90 * 60_000 : 20_000);
      if (args[0] === "repo") {
        return JSON.stringify({ nameWithOwner: "example/tooling" });
      }
      if (args[0] === "run" && args[1] === "watch") {
        state.waits.push(timeout);
        state.watch();
        return "";
      }
      if (args[0] === "run" && args[1] === "rerun") {
        return rerunFailed(args);
      }
      const method = args[1] === "--method" ? args[2] : "GET";
      const endpoint = method === "GET" ? args[1]! : args[3]!;
      if (method !== "GET") {
        state.effects.push(command);
        assert.equal(method, "POST", "automated recovery must never delete a label");
        if (endpoint === "repos/example/tooling/labels") {
          const name = args.find((arg) => arg.startsWith("name="))!.slice(5);
          const description = args.find((arg) => arg.startsWith("description="))!.slice(12);
          if (state.labels.has(name)) {
            throw new Error("HTTP 422: label already exists");
          }
          if (state.failCreate) {
            throw new Error("create failed before any effect");
          }
          state.labels.set(name, {
            name,
            description: state.foreignCreate
              ? "ci-full:v1:pr:7:owner:ffffffff-ffff-4fff-8fff-ffffffffffff"
              : description,
          });
          state.afterCreate();
          if (state.loseCreate || state.foreignCreate) {
            throw new Error("create response lost");
          }
          return "{}";
        }
        assert.equal(endpoint, "repos/example/tooling/issues/7/labels");
        state.beforePost();
        state.pr.labels.push({ name: args.find((arg) => arg.startsWith("labels[]="))!.slice(9) });
        if (state.discover) {
          const id = Math.max(101, ...state.runs.map((run) => run.id)) + 1;
          state.runs.push({
            ...runMetadata(),
            id,
            html_url: url.replace("101", String(id)),
            status: "queued",
            conclusion: "",
          });
        }
        if (state.losePost) {
          throw new Error("response lost after POST");
        }
        return "[]";
      }
      if (endpoint === "user") {
        return JSON.stringify(state.user);
      }
      if (endpoint === "repos/example/tooling") {
        return JSON.stringify({ id: 11, full_name: "example/tooling" });
      }
      if (endpoint === "repos/example/tooling/pulls/7") {
        return JSON.stringify(state.pr);
      }
      if (endpoint === "repos/example/tooling/actions/workflows/ci.yml") {
        return JSON.stringify(state.workflow);
      }
      if (endpoint.startsWith("repos/example/tooling/labels?")) {
        return JSON.stringify([{ name: "ci:full" }]);
      }
      if (endpoint.startsWith("repos/example/tooling/labels/")) {
        const name = decodeURIComponent(endpoint.split("/").at(-1)!);
        const label = state.labels.get(name);
        if (!label) {
          throw new Error("HTTP 404: no repository label");
        }
        return JSON.stringify(label);
      }
      if (endpoint.includes("/workflows/")) {
        return JSON.stringify({ workflow_runs: state.runs });
      }
      if (endpoint.includes("/jobs?")) {
        const attempt = /\/attempts\/([0-9]+)\/jobs/u.exec(endpoint)?.[1];
        return JSON.stringify({
          jobs:
            attempt === undefined
              ? state.jobs
              : state.jobs.filter((job) => job.run_attempt === Number(attempt)),
        });
      }
      if (endpoint.includes("/actions/runs/")) {
        state.beforeReadRun();
        return JSON.stringify(
          state.runs.find((run) => String(run.id) === endpoint.split("/").at(-1)),
        );
      }
      throw new Error(`Unexpected test request: ${command.join(" ")}`);
    },
    async delay(milliseconds) {
      state.delays.push(milliseconds);
    },
  };
  return { state, port };
}

export type FixtureState = ReturnType<typeof fixture>["state"];
export const sourceChanges: readonly ((state: FixtureState) => void)[] = [
  (state) => {
    state.pr.head.sha = "c".repeat(40);
  },
  (state) => {
    state.pr.base.sha = "c".repeat(40);
  },
  (state) => {
    state.pr.base.ref = "canary";
  },
  (state) => {
    state.pr.head.repo.id = 23;
  },
  (state) => {
    state.pr.head.repo.full_name = "other/tooling";
  },
  (state) => {
    state.pr.head.ref = "other-branch";
  },
];
