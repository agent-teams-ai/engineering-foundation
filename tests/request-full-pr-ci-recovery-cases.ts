import assert from "node:assert/strict";
import test from "node:test";
import { createFullCiPort, readFullPrCi, requestFullPrCi } from "../scripts/request-full-pr-ci.mts";
import {
  fixture,
  runMetadata,
  url,
  sourceChanges,
  type FixtureState,
} from "./request-full-pr-ci-fixture.ts";

async function nameFor(
  change: (state: FixtureState) => void,
  repoId = 11,
  repoName = "example/tooling",
  pr = 7,
  nonce = "00000000-0000-4000-8000-000000000001",
) {
  const { state, port } = fixture();
  change(state);
  state.failCreate = true;
  state.pr.number = pr;
  state.pr.base.repo = { id: repoId, full_name: repoName };
  port.nonce = () => nonce;
  const gh = port.gh;
  port.gh = async (args, timeout) => {
    const translated = args.map((arg) =>
      arg.replaceAll(repoName, "example/tooling").replace(`/pulls/${pr}`, "/pulls/7"),
    );
    const response = await gh(translated, timeout);
    if (args[0] === "repo") {
      return JSON.stringify({ nameWithOwner: repoName });
    }
    if (args[1] === `repos/${repoName}`) {
      return JSON.stringify({ id: repoId, full_name: repoName });
    }
    return response;
  };
  await assert.rejects(requestFullPrCi(["--pr", String(pr)], port), /effect uncertain/u);
  assert.equal(state.effects.length, 1);
  return state.effects[0]!.find((arg) => arg.startsWith("name="))!.slice(5);
}

function registerCurrentAttemptCases(): void {
  // RED: a newly discovered run's cached list status used to decide whether to
  // watch. Fresh detail can require a watch or already prove completion.
  void test("new request detail controls watching despite stale run-list completion", async () => {
    for (const needsWatch of [true, false]) {
      const { state, port } = fixture();
      const gh = port.gh;
      const complete = () => {
        state.runs[0]!.status = "completed";
        state.runs[0]!.conclusion = "success";
        for (const job of state.jobs) {
          job.run_id = 102;
        }
      };
      state.watch = complete;
      if (!needsWatch) {
        state.beforeReadRun = complete;
      }
      port.gh = async (args, timeout) => {
        const response = await gh(args, timeout);
        if (needsWatch && args[1]?.includes("/workflows/ci.yml/runs?")) {
          return JSON.stringify({
            workflow_runs: state.runs.map((run) => ({
              ...run,
              status: "completed",
              conclusion: "success",
            })),
          });
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
  void test("status, conclusion or attempt drift after jobs or latest discovery rejects readiness", async () => {
    for (const phase of ["jobs", "latest"]) {
      for (const field of ["status", "conclusion", "attempt"]) {
        const { state, port } = fixture();
        state.runs = [runMetadata()];
        const gh = port.gh;
        let jobReads = 0;
        let changed = false;
        port.gh = async (args, timeout) => {
          const response = await gh(args, timeout);
          if (args[1]?.includes("/jobs?")) {
            jobReads += 1;
          }
          const boundary =
            phase === "jobs"
              ? args[1]?.includes("/jobs?")
              : args[1]?.includes("/workflows/ci.yml/runs?");
          if (boundary && jobReads >= 2 && !changed) {
            changed = true;
            if (field === "status") {
              state.runs[0]!.status = "in_progress";
            } else if (field === "conclusion") {
              state.runs[0]!.conclusion = "failure";
            } else {
              state.runs[0]!.run_attempt += 1;
            }
          }
          return response;
        };
        await assert.rejects(
          requestFullPrCi(["--pr", "7", "--wait"], port),
          /changed/u,
          `${phase}: ${field}`,
        );
        assert.ok(changed, `${phase}: ${field} crossed the observation boundary`);
        assert.deepEqual(state.effects, []);
      }
    }
  });

  // RED: attempt-only jobs omit successful gates retained from earlier attempts
  // after selective retry, so the old helper posted another full request.
  void test("selective retries qualify the latest effective gates across bounded job attempts", async () => {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), run_attempt: 3 }];
    state.jobs.forEach((job, index) => {
      job.run_attempt = [1, 2, 2, 3][index]!;
    });
    assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
    assert.deepEqual(state.effects, []);
    assert.ok(
      state.reads.some((args) => args[1]?.includes("/actions/runs/101/jobs?filter=latest")),
    );
    assert.ok(state.reads.every((args) => !args[1]?.includes("/attempts/")));
  });

  // A historical success cannot mask a failed effective gate or make duplicate
  // gate entries from different attempts safe to accept.
  void test("selective retries reject unsuccessful or ambiguous latest effective gate evidence", async () => {
    for (const defect of ["failure", "skipped", "neutral", "duplicate-attempt"]) {
      const { state, port } = fixture();
      state.runs = [{ ...runMetadata(), run_attempt: 3 }];
      const gate = state.jobs.find((job) => job.name === "check")!;
      gate.run_attempt = 3;
      if (defect === "duplicate-attempt") {
        state.jobs.push({ ...gate, id: 2001, run_attempt: 1 });
      } else {
        gate.conclusion = defect;
      }
      await assert.rejects(
        requestFullPrCi(["--pr", "7"], port),
        /malformed gate evidence/u,
        defect,
      );
      assert.deepEqual(state.effects, [], defect);
    }
  });

  void test("truncated latest job discovery cannot reuse partial successful gates", async () => {
    const { state, port } = fixture();
    state.runs = [runMetadata()];
    state.jobs.push(
      ...Array.from({ length: 96 }, (_, index) => ({
        ...state.jobs[0]!,
        id: 2001 + index,
        name: `producer-${index}`,
      })),
    );
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /300-entry bound/u);
    assert.deepEqual(state.effects, []);
  });

  void test("the production port constructor gives concurrent callers distinct UUID ownership", async () => {
    const { state, port } = fixture();
    const first = createFullCiPort(port.gh);
    const second = createFullCiPort(port.gh);
    first.delay = port.delay;
    second.delay = port.delay;
    await Promise.all([
      requestFullPrCi(["--pr", "7"], first),
      requestFullPrCi(["--pr", "7"], second),
    ]);
    const creations = state.effects.filter((args) => args[3] === "repos/example/tooling/labels");
    assert.equal(creations.length, 2);
    assert.notEqual(creations[0]!.at(-1), creations[1]!.at(-1));
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 1);
    assert.equal(state.runs.length, 1);
  });

  void test("concurrent lost creation and attachment acknowledgements still emit only one event", async () => {
    const { state, port } = fixture();
    state.loseCreate = true;
    state.losePost = true;
    const results = await Promise.all([
      requestFullPrCi(["--pr", "7"], port),
      requestFullPrCi(["--pr", "7"], port),
    ]);
    assert.equal(results[0]!.url, results[1]!.url);
    assert.equal(
      state.effects.filter((args) => args[3] === "repos/example/tooling/labels").length,
      2,
    );
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 1);
    assert.equal(state.runs.length, 1);
  });

  void test("the deterministic reservation binds every canonical source field and excludes the caller nonce", async () => {
    const canonical = await nameFor(() => {});
    assert.equal(canonical, "ci:full:d280726194e4547d25b91c21a836ba1e533d2942");
    assert.equal(
      await nameFor(() => {}, 11, "example/tooling", 7, "00000000-0000-4000-8000-000000000002"),
      canonical,
    );
    assert.equal(
      await nameFor((state) => {
        state.pr.labels = [{ name: "ci:full" }];
      }),
      canonical,
    );
    const names = [canonical];
    for (const change of sourceChanges) {
      names.push(await nameFor(change));
    }
    names.push(
      await nameFor(() => {}, 12),
      await nameFor(() => {}, 11, "example/other"),
      await nameFor(() => {}, 11, "example/tooling", 8),
    );
    assert.equal(new Set(names).size, names.length);
  });
}

function registerReservationOwnershipCases(): void {
  void test("reservation is independent of the global repository label inventory", async () => {
    const { state, port } = fixture();
    for (let i = 0; i < 400; i += 1) {
      state.labels.set(`unrelated-${i}`, { name: `unrelated-${i}`, description: "unrelated" });
    }
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      assert.ok(
        !args[1]?.startsWith("repos/example/tooling/labels?"),
        "global label enumeration is forbidden",
      );
      return gh(args, timeout);
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
    assert.equal(state.labels.size, 401);
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 1);
  });

  void test("a lost creation response owned by another nonce cannot attach, even when a bound run appears", async () => {
    const { state, port } = fixture();
    state.foreignCreate = true;
    state.afterCreate = () => {
      state.runs = [runMetadata()];
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "ready");
    assert.equal(state.effects.length, 1);
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
  });

  void test("an orphaned reservation stays bounded and read-only without takeover or attachment", async () => {
    const { state, port } = fixture();
    state.foreignCreate = true;
    for (let call = 0; call < 2; call += 1) {
      await assert.rejects(
        requestFullPrCi(["--pr", "7"], port),
        /reserved snapshot.*manually requesting ci:full/u,
      );
    }
    assert.equal(state.labels.size, 1);
    assert.equal(
      state.effects.length,
      2,
      "each invocation attempts creation once and never takes over",
    );
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
    assert.equal(state.delays.filter((delay) => delay === 5000).length, 22);
  });

  void test("an unconfirmed creation fails closed after three exact reads and never repeats the write", async () => {
    const { state, port } = fixture();
    state.failCreate = true;
    await assert.rejects(
      requestFullPrCi(["--pr", "7"], port),
      /Reservation creation effect uncertain/u,
    );
    assert.equal(state.effects.length, 1);
    assert.equal(
      state.reads.filter((args) => args[1]?.startsWith("repos/example/tooling/labels/")).length,
      3,
    );
    assert.deepEqual(state.delays, [250, 500]);
  });

  void test("malformed reservation ownership is never authority to attach", async () => {
    for (const response of [
      { name: "wrong", description: "other" },
      { name: "ci:full:d280726194e4547d25b91c21a836ba1e533d2942" },
    ]) {
      const { state, port } = fixture();
      const gh = port.gh;
      port.gh = async (args, timeout) =>
        args[1]?.startsWith("repos/example/tooling/labels/")
          ? JSON.stringify(response)
          : gh(args, timeout);
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /ownership malformed/u);
      assert.equal(state.effects.length, 1);
    }
  });

  void test("non-User and malformed user identities reject all writes, while read-only reuse needs no user endpoint", async () => {
    for (const user of [
      { type: "Bot", id: 31, login: "github-actions" },
      { type: "User", id: 0, login: "operator" },
      { type: "User", id: 1.5, login: "operator" },
      { type: "User", id: 31, login: "" },
      { type: "User", id: 31, login: "bad/login" },
      { id: 31, login: "operator" },
      { type: "User", login: "operator" },
    ]) {
      const { state, port } = fixture();
      const gh = port.gh;
      port.gh = async (args, timeout) =>
        args[1] === "user" ? JSON.stringify(user) : gh(args, timeout);
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /user-authenticated/u);
      assert.deepEqual(state.effects, []);
    }
    for (const status of ["completed", "queued"]) {
      const { state, port } = fixture();
      state.runs = [{ ...runMetadata(), status }];
      const gh = port.gh;
      port.gh = async (args, timeout) => {
        assert.notEqual(args[1], "user");
        return gh(args, timeout);
      };
      assert.equal(
        (await requestFullPrCi(["--pr", "7"], port)).outcome,
        status === "completed" ? "ready" : "requested",
      );
      assert.deepEqual(state.effects, []);
    }
  });

  void test("malformed caller nonces reject before creation and reuse never allocates a nonce", async () => {
    for (const nonce of ["", "other", "a".repeat(101)]) {
      const { state, port } = fixture();
      port.nonce = () => nonce;
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /owner UUID/u);
      assert.deepEqual(state.effects, []);
    }
    const { state, port } = fixture();
    state.runs = [runMetadata()];
    port.nonce = () => {
      throw new Error("read-only reuse must not allocate ownership");
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "ready");
  });

  void test("head or source bindings changed during reservation prevent both attachment and failed-job rerun", async () => {
    for (const retry of [false, true]) {
      for (const change of sourceChanges) {
        const { state, port } = fixture();
        if (retry) {
          state.runs = [{ ...runMetadata(), conclusion: "failure" }];
        }
        state.afterCreate = () => {
          change(state);
        };
        await assert.rejects(requestFullPrCi(["--pr", "7"], port), /head\/base changed/u);
        assert.equal(state.effects.length, 1, "only the reservation may have been created");
      }
    }
  });

  void test("two concurrent helpers retry failed jobs once and qualify GitHub's cloned current-attempt job rows", async () => {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), conclusion: "failure" }];
    state.jobs[3]!.conclusion = "failure";
    state.watch = () => {
      state.runs[0]!.status = "completed";
      state.runs[0]!.conclusion = "success";
      state.jobs[3]!.conclusion = "success";
    };
    const results = await Promise.all([
      requestFullPrCi(["--pr", "7", "--wait"], port),
      requestFullPrCi(["--pr", "7", "--wait"], port),
    ]);
    assert.ok(results.every((result) => result.outcome === "ready" && result.url === url));
    assert.equal(state.runs[0]!.run_attempt, 2);
    assert.ok(state.jobs.every((job) => job.run_attempt === 2));
    assert.equal(state.effects.filter((args) => args[1] === "rerun").length, 1);
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
    assert.equal(state.labels.size, 1);
    assert.notEqual(
      [...state.labels.keys()][0],
      "ci:full:d280726194e4547d25b91c21a836ba1e533d2942",
      "retry and request reservations differ",
    );
    assert.deepEqual(state.pr.labels, []);
  });
}

function registerSelectiveRetryCases(): void {
  void test("each unsuccessful completed run uses the explicit failed-job rerun command", async () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "startup_failure",
      "stale",
    ]) {
      const { state, port } = fixture();
      state.runs = [{ ...runMetadata(), conclusion }];
      assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
      assert.deepEqual(state.effects[1], [
        "run",
        "rerun",
        "101",
        "--repo",
        "example/tooling",
        "--failed",
      ]);
      assert.equal(state.effects.length, 2);
      assert.deepEqual(state.pr.labels, []);
    }
  });

  void test("lost rerun acknowledgements reconcile delayed next attempts through reads only", async () => {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), conclusion: "failure" }];
    state.discoverRerun = false;
    state.loseRerun = true;
    port.delay = async (milliseconds) => {
      state.delays.push(milliseconds);
      if (state.delays.length === 2) {
        state.runs[0]!.run_attempt = 2;
        state.runs[0]!.status = "queued";
        state.runs[0]!.conclusion = "";
      }
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
    assert.deepEqual(state.delays, [5000, 5000]);
    assert.equal(state.effects.filter((args) => args[1] === "rerun").length, 1);
    assert.equal(state.effects.length, 2);
  });

  void test("a rerun reservation with no next attempt fails boundedly and a second invocation cannot resubmit", async () => {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), conclusion: "failure" }];
    state.discoverRerun = false;
    state.loseRerun = true;
    for (let call = 0; call < 2; call += 1) {
      await assert.rejects(requestFullPrCi(["--pr", "7"], port), /Retry effect uncertain/u);
    }
    assert.equal(state.effects.filter((args) => args[1] === "rerun").length, 1);
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
    assert.equal(state.delays.filter((delay) => delay === 5000).length, 22);
  });

  void test("a next attempt that appears during reservation is reused without another rerun", async () => {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), conclusion: "failure" }];
    state.afterCreate = () => {
      state.runs[0]!.run_attempt = 2;
      state.runs[0]!.status = "queued";
      state.runs[0]!.conclusion = "";
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
    assert.equal(state.effects.length, 1);
  });

  void test("rerun discovery tolerates a lagging list attempt through bounded reads", async () => {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), conclusion: "failure" }];
    const gh = port.gh;
    let laggingReads = 0;
    port.gh = async (args, timeout) => {
      const response = await gh(args, timeout);
      if (
        args[1]?.includes("/workflows/ci.yml/runs?") &&
        state.runs[0]!.run_attempt === 2 &&
        ++laggingReads <= 3
      ) {
        return JSON.stringify({ workflow_runs: [{ ...state.runs[0], run_attempt: 1 }] });
      }
      return response;
    };
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
    assert.ok(state.delays.length > 0);
    assert.equal(state.effects.filter((args) => args[1] === "rerun").length, 1);
  });

  void test("retry attempts beyond the one authorized successor and newer requests reject instead of resubmitting", async () => {
    for (const phase of ["reservation", "rerun"]) {
      for (const drift of ["attempt", "request"]) {
        const { state, port } = fixture();
        state.runs = [{ ...runMetadata(), conclusion: "failure" }];
        const change = () => {
          if (drift === "attempt") {
            state.runs[0]!.run_attempt = 3;
          } else {
            state.runs.push({ ...runMetadata(), id: 103, html_url: url.replace("101", "103") });
          }
        };
        if (phase === "reservation") {
          state.afterCreate = change;
        } else {
          const gh = port.gh;
          port.gh = async (args, timeout) => {
            const response = await gh(args, timeout);
            if (args[1] === "rerun") {
              change();
            }
            return response;
          };
        }
        await assert.rejects(requestFullPrCi(["--pr", "7"], port), /changed/u);
        assert.equal(
          state.effects.filter((args) => args[1] === "rerun").length,
          phase === "rerun" ? 1 : 0,
        );
        assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
      }
    }
  });

  void test("watch stays pinned to the specific bound run and attempt for reuse, new requests and retries", async () => {
    for (const path of ["reuse", "request", "retry"]) {
      for (const drift of ["attempt", "request"]) {
        const { state, port } = fixture();
        if (path !== "request") {
          state.runs = [
            {
              ...runMetadata(),
              status: path === "retry" ? "completed" : "queued",
              conclusion: "failure",
            },
          ];
        }
        state.watch = () => {
          const current = state.runs[0]!;
          if (drift === "attempt") {
            current.run_attempt += 1;
          } else {
            state.runs.push({ ...runMetadata(), id: 103, html_url: url.replace("101", "103") });
          }
        };
        await assert.rejects(
          requestFullPrCi(["--pr", "7", "--wait"], port),
          /changed/u,
          `${path}: ${drift}`,
        );
        assert.equal(state.waits.length, 1);
        assert.equal(
          state.effects.filter((args) => args[1] === "rerun").length,
          path === "retry" ? 1 : 0,
        );
        assert.equal(
          state.effects.filter((args) => args[3]?.includes("/issues/")).length,
          path === "request" ? 1 : 0,
        );
      }
    }
  });

  void test("retry reservations bind both the failed run ID and its current attempt", async () => {
    const names: string[] = [];
    for (const [id, attempt] of [
      [101, 1],
      [102, 1],
      [101, 2],
    ]) {
      const { state, port } = fixture();
      state.runs = [
        {
          ...runMetadata(),
          id: id!,
          html_url: url.replace("101", String(id)),
          run_attempt: attempt!,
          conclusion: "failure",
        },
      ];
      await requestFullPrCi(["--pr", "7"], port);
      names.push([...state.labels.keys()][0]!);
    }
    assert.equal(new Set(names).size, 3);
  });

  void test("the gate inspection API is read-only for ready, pending, failed, malformed and absent evidence", async () => {
    for (const scenario of ["ready", "pending", "failed", "malformed", "absent"]) {
      const { state, port } = fixture();
      const gh = port.gh;
      if (scenario !== "absent") {
        state.runs = [runMetadata()];
      }
      if (scenario === "pending") {
        state.runs[0]!.status = "queued";
        state.runs[0]!.conclusion = "";
      }
      if (scenario === "failed") {
        state.runs[0]!.conclusion = "failure";
      }
      if (scenario === "malformed") {
        state.jobs[0]!.conclusion = "skipped";
      }
      port.nonce = () => {
        throw new Error("inspection must never allocate reservation ownership");
      };
      port.gh = async (args, timeout) => {
        assert.notEqual(args[1], "user");
        return gh(args, timeout);
      };
      if (scenario === "ready" || scenario === "pending") {
        assert.equal(
          (await readFullPrCi(["--pr", "7"], port)).outcome,
          scenario === "ready" ? "ready" : "requested",
        );
      } else {
        await assert.rejects(readFullPrCi(["--pr", "7"], port), /not successful|No exact bound/u);
      }
      assert.deepEqual(state.effects, []);
    }
    const { state, port } = fixture();
    await assert.rejects(readFullPrCi(["--pr", "0"], port), /Usage/u);
    assert.deepEqual(state.reads, []);
  });
}

export function registerFullCiRecoveryCases(): void {
  registerCurrentAttemptCases();
  registerReservationOwnershipCases();
  registerSelectiveRetryCases();
}
