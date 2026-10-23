import assert from "node:assert/strict";
import test from "node:test";

import { requestFullPrCi } from "../scripts/request-full-pr-ci.mts";

import { fixture, runMetadata, head, base, baseRef, url } from "./request-full-pr-ci-fixture.ts";
import { registerFullCiRecoveryCases } from "./request-full-pr-ci-recovery-cases.ts";

// Input mistakes must never reach a provider, including a label write.
test("malformed requests reject before GitHub IO", async () => {
  for (const args of [
    [],
    ["--pr", "0"],
    ["--pr", "01"],
    ["--pr", "-1"],
    ["--pr", "1;touch"],
    ["--pr", "9007199254740992"],
    ["--pr", "7", "--wait", "--wait"],
    ["--pr", "7", "--repo"],
    ["--wait", "--pr", "7"],
  ]) {
    const { state, port } = fixture();
    await assert.rejects(requestFullPrCi(args, port));
    assert.deepEqual(state.reads, []);
  }
});

test("two simultaneous helpers reserve one writer and emit exactly one labeled event", async () => {
  const { state, port } = fixture();
  // The shared backend emits an event on EVERY attachment POST, including an
  // identical label. Only atomic repository-label creation can serialize it.
  const results = await Promise.all([
    requestFullPrCi(["--pr", "7"], port),
    requestFullPrCi(["--pr", "7"], port),
  ]);
  assert.equal(results[0]!.url, results[1]!.url);
  assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 1);
  assert.equal(state.runs.length, 1);
  assert.equal(state.labels.size, 1);
  const reservation = [...state.labels.values()][0]!;
  assert.match(reservation.name, /^ci:full:[a-f0-9]{40}$/u);
  assert.match(reservation.description, /^ci-full:v1:pr:7:owner:[a-f0-9-]{36}$/u);
  assert.ok(Buffer.byteLength(reservation.description) <= 100);
  assert.ok(state.reads.every((args) => !args[1]?.startsWith("repos/example/tooling/labels?")));
});

test("suppressed installation credentials reject before all request and retry writes", async () => {
  for (const retry of [false, true]) {
    const { state, port } = fixture();
    if (retry) {
      state.runs = [{ ...runMetadata(), conclusion: "failure" }];
    }
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      if (args[1] === "user") {
        throw new Error("HTTP 403: Resource not accessible by integration");
      }
      return gh(args, timeout);
    };
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /user-authenticated/u);
    assert.deepEqual(state.effects, []);
  }
});

test("GitHub custom run-name and four successful native gates reuse a fork run without mutation", async () => {
  const { state, port } = fixture();
  state.runs = [runMetadata()];
  assert.deepEqual(await requestFullPrCi(["--", "--pr", "7", "--wait"], port), {
    outcome: "ready",
    url,
    head,
    base,
    baseRef,
  });
  assert.deepEqual(state.effects, []);
  assert.deepEqual(state.waits, []);
  assert.ok(state.reads.some((args) => args[1]?.includes("/actions/runs/101/jobs?filter=latest")));
  assert.ok(
    state.reads.some((args) => args[1] === "repos/example/tooling/actions/workflows/ci.yml"),
  );
});

// Real fork run 37227989632 has no pull_requests entries. Source repository,
// branch and the frozen event title remain independently available from GitHub.
test("real-shaped empty fork associations reuse exact source evidence but never same-repository evidence", async () => {
  const { state, port } = fixture();
  const run = runMetadata();
  run.pull_requests = [];
  state.runs = [run];
  assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
  assert.deepEqual(state.effects, []);

  const other = fixture();
  const unassociated = runMetadata();
  unassociated.pull_requests = [];
  other.state.pr.head.repo = { id: 11, full_name: "example/tooling" };
  unassociated.head_repository = { id: 11, full_name: "example/tooling" };
  other.state.runs = [unassociated];
  other.state.discover = false;
  await assert.rejects(requestFullPrCi(["--pr", "7"], other.port), /effect uncertain/u);
  assert.deepEqual(
    other.state.effects.map((args) => args[2]),
    ["POST", "POST"],
  );
});

test("transient reads retry boundedly while malformed JSON is never retried", async () => {
  const { state, port } = fixture();
  state.runs = [runMetadata()];
  const original = port.gh;
  let reads = 0;
  const delays: number[] = [];
  port.gh = async (args, timeout) => {
    if (args[0] === "repo" && ++reads <= 2) {
      throw new Error("transient read response lost");
    }
    return original(args, timeout);
  };
  port.delay = async (milliseconds) => {
    delays.push(milliseconds);
  };
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "ready");
  assert.equal(reads, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.deepEqual(state.effects, []);

  const malformed = fixture();
  let malformedReads = 0;
  malformed.port.gh = async () => {
    malformedReads += 1;
    return "{";
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], malformed.port), SyntaxError);
  assert.equal(malformedReads, 1);
  assert.deepEqual(malformed.state.effects, []);
});

test("canonical workflow metadata must identify CI before a label mutation", async () => {
  for (const workflow of [
    { id: 55, name: "PR Feedback", path: ".github/workflows/ci.yml" },
    { id: 55, name: "CI", path: ".github/workflows/pr-feedback.yml" },
    { id: 0, name: "CI", path: ".github/workflows/ci.yml" },
  ]) {
    const { state, port } = fixture();
    state.workflow = workflow;
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /workflow identity|identifier/u);
    assert.deepEqual(state.effects, []);
  }
});

test("a fresh fork request creates the repository reservation and waits for its emitted native run", async () => {
  const { state, port } = fixture();
  state.watch = () => {
    state.runs[0]!.status = "completed";
    state.runs[0]!.conclusion = "success";
    for (const job of state.jobs) {
      job.run_id = 102;
    }
  };
  assert.deepEqual(await requestFullPrCi(["--pr", "7", "--wait"], port), {
    outcome: "ready",
    url: url.replace("101", "102"),
    head,
    base,
    baseRef,
  });
  const reservation = [...state.labels.values()][0]!;
  assert.match(reservation.name, /^ci:full:[a-f0-9]{40}$/u);
  assert.deepEqual(state.effects[1], [
    "api",
    "--method",
    "POST",
    "repos/example/tooling/issues/7/labels",
    "-f",
    `labels[]=${reservation.name}`,
  ]);
  assert.equal(state.effects.length, 2);
  const created = state.reads.findIndex((args) => args[3] === "repos/example/tooling/labels");
  const confirmed = state.reads.findIndex(
    (args) => args[1] === `repos/example/tooling/labels/${encodeURIComponent(reservation.name)}`,
  );
  const attached = state.reads.findIndex((args) => args[3]?.includes("/issues/"));
  assert.ok(
    created < confirmed && confirmed < attached,
    "even successful creation must be read back before attachment",
  );
  assert.deepEqual(state.waits, [90 * 60_000]);
});

// Each mutation represents an independent wrong-source/stale evidence fixture.
test("dispatch, unrequested, wrong workflow/repo/PR/head/base runs cannot bless a PR", async () => {
  for (const change of [
    (r: ReturnType<typeof runMetadata>) => {
      r.event = "workflow_dispatch";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.display_title = "CI pull_request run 101";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.path = ".github/workflows/pr-feedback.yml";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.workflow_id = 56;
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.name = "CI";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.repository.id = 12;
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.repository.full_name = "other/tooling";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.head_repository.id = 23;
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.head_repository.full_name = "other/tooling";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.head_branch = "other-branch";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.pull_requests[0]!.number = 8;
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.head_sha = "c".repeat(40);
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.pull_requests[0]!.base.sha = "c".repeat(40);
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.pull_requests[0]!.head.repo.id = 23;
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.pull_requests[0]!.head.ref = "other-branch";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.pull_requests[0]!.base.repo.id = 12;
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.pull_requests[0]!.base.ref = "canary";
    },
    (r: ReturnType<typeof runMetadata>) => {
      r.display_title = `Full CI #7 @${head} on ${"c".repeat(40)}`;
    },
  ]) {
    const { state, port } = fixture();
    const run = runMetadata();
    change(run);
    state.runs = [run];
    const result = await requestFullPrCi(["--pr", "7"], port);
    assert.equal(result.outcome, "requested");
    assert.equal(state.effects.length, 2);
    assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 1);
  }
});

test("malformed successful evidence fails closed while unsuccessful runs retry only failed jobs", async () => {
  for (const defect of [
    "skipped",
    "neutral",
    "missing",
    "duplicate",
    "failed-run",
    "cancelled",
    "newer-failed",
  ]) {
    const { state, port } = fixture();
    state.runs = [runMetadata()];
    state.pr.labels = [{ name: "ci:full" }];
    if (defect === "missing") {
      state.jobs = [];
    } else if (defect === "duplicate") {
      state.jobs.push({ ...state.jobs[0]! });
    } else if (defect === "failed-run" || defect === "cancelled") {
      state.runs[0]!.conclusion = defect === "cancelled" ? "cancelled" : "failure";
    } else if (defect === "newer-failed") {
      state.runs.push({
        ...runMetadata(),
        id: 102,
        html_url: url.replace("101", "102"),
        conclusion: "failure",
      });
      state.discover = false;
    } else {
      state.jobs[0]!.conclusion = defect;
    }
    if (["failed-run", "cancelled", "newer-failed"].includes(defect)) {
      assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
      assert.equal(state.effects.length, 2);
      assert.equal(state.effects[1]![1], "rerun");
      assert.equal(state.effects[1]![2], defect === "newer-failed" ? "102" : "101");
      assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
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
    for (const defect of [
      "missing",
      "duplicate",
      "skipped",
      "neutral",
      "failure",
      "cancelled",
      "wrong-run",
      "pending",
      "wrong-head",
      "missing-head",
      "future-attempt",
      "zero-attempt",
      "fractional-attempt",
      "missing-attempt",
      "missing-id",
      "zero-id",
      "duplicate-id",
    ]) {
      const { state, port } = fixture();
      state.runs = [runMetadata()];
      const job = state.jobs.find((entry) => entry.name === name)!;
      if (defect === "missing") {
        state.jobs = state.jobs.filter((entry) => entry !== job);
      } else if (defect === "duplicate") {
        state.jobs.push({ ...job });
      } else if (defect === "wrong-run") {
        job.run_id = 99;
      } else if (defect === "wrong-head") {
        job.head_sha = "c".repeat(40);
      } else if (defect === "missing-head") {
        delete job.head_sha;
      } else if (defect === "future-attempt") {
        job.run_attempt = 2;
      } else if (defect === "zero-attempt") {
        job.run_attempt = 0;
      } else if (defect === "fractional-attempt") {
        job.run_attempt = 1.5;
      } else if (defect === "missing-attempt") {
        delete job.run_attempt;
      } else if (defect === "missing-id") {
        delete job.id;
      } else if (defect === "zero-id") {
        job.id = 0;
      } else if (defect === "duplicate-id") {
        job.id = state.jobs.find((entry) => entry !== job)!.id;
      } else if (defect === "pending") {
        job.status = "in_progress";
      } else {
        job.conclusion = defect;
      }
      await assert.rejects(
        requestFullPrCi(["--pr", "7"], port),
        /malformed gate evidence/u,
        `${name}: ${defect}`,
      );
      assert.deepEqual(
        state.effects,
        [],
        `${name}: ${defect} must not reuse invalid evidence or submit fresh work`,
      );
    }
  }
});

test("in-progress requests are reused and bounded watch rereads the actual gate", async () => {
  const { state, port } = fixture();
  state.runs = [{ ...runMetadata(), status: "in_progress", conclusion: "" }];
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  state.watch = () => {
    state.runs[0]!.status = "completed";
    state.runs[0]!.conclusion = "success";
  };
  assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
  assert.deepEqual(state.effects, []);
  assert.deepEqual(state.waits, [90 * 60_000]);
});

// A queued list snapshot can lag fresh detail during a legitimate transition.
// It must not cause a duplicate request or discard successful job evidence.
test("stale run-list lifecycle state does not invalidate the same current attempt", async () => {
  for (const status of ["in_progress", "completed"] as const) {
    const { state, port } = fixture();
    state.runs = [
      { ...runMetadata(), status, conclusion: status === "completed" ? "success" : "" },
    ];
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      if (args[1]?.includes("/actions/workflows/ci.yml/runs?")) {
        return JSON.stringify({
          workflow_runs: state.runs.map((run) => ({ ...run, status: "queued", conclusion: "" })),
        });
      }
      return gh(args, timeout);
    };
    assert.equal(
      (await requestFullPrCi(["--pr", "7"], port)).outcome,
      status === "completed" ? "ready" : "requested",
    );
    assert.deepEqual(state.effects, []);
  }
});

test("failed or skipped watched work never reports ready", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), status: "queued", conclusion: "" }];
    state.watch = () => {
      state.runs[0]!.status = "completed";
      state.runs[0]!.conclusion = conclusion;
      throw new Error("watch failed");
    };
    await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /not successful/u);
    assert.deepEqual(state.effects, []);
  }
});

test("head/base changes before effects, during request and during wait fail closed", async () => {
  for (const field of ["head", "base"] as const) {
    for (const phase of ["request", "wait", "reuse"]) {
      const { state, port } = fixture();
      const change = () => {
        state.pr[field].sha = "c".repeat(40);
      };
      if (phase === "request") {
        state.beforePost = change;
      } else {
        state.runs = [runMetadata()];
        if (phase === "wait") {
          state.runs[0]!.status = "queued";
          state.watch = change;
        } else {
          state.beforeReadRun = change;
        }
      }
      await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /head\/base changed/u);
    }
  }
  const { state, port } = fixture();
  const original = port.gh;
  port.gh = async (args, timeout) => {
    const result = await original(args, timeout);
    if (args[1] === "--method" && args[3] === "repos/example/tooling/labels") {
      state.pr.head.sha = "c".repeat(40);
    }
    return result;
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /head\/base changed/u);
  assert.equal(state.effects.filter((args) => args[3]?.includes("/issues/")).length, 0);
});

test("changed PR source repository or branch cannot reuse success from the same head/base", async () => {
  for (const field of ["id", "full_name", "ref"] as const) {
    const { state, port } = fixture();
    state.runs = [runMetadata()];
    state.beforeReadRun = () => {
      if (field === "id") {
        state.pr.head.repo.id = 23;
      } else if (field === "full_name") {
        state.pr.head.repo.full_name = "other/tooling";
      } else {
        state.pr.head.ref = "other-branch";
      }
    };
    await assert.rejects(requestFullPrCi(["--pr", "7", "--wait"], port), /head\/base changed/u);
    assert.deepEqual(state.effects, []);
  }
});

test("lost creation and attachment responses reconcile once and preserve the legacy label", async () => {
  const { state, port } = fixture();
  state.pr.labels = [{ name: "ci:full" }];
  state.losePost = true;
  state.loseCreate = true;
  assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested");
  assert.deepEqual(
    state.effects.map((args) => args[2]),
    ["POST", "POST"],
  );
  assert.ok(state.pr.labels.some((label) => label.name === "ci:full"));
});

test("undiscovered effects stay uncertain after bounded observations", async () => {
  const { state, port } = fixture();
  state.losePost = true;
  state.discover = false;
  let delays = 0;
  port.delay = async () => {
    delays += 1;
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /effect uncertain/u);
  assert.equal(state.effects.length, 2);
  assert.equal(delays, 11);
});

test("metadata truncation fails before mutation and changed run attempts reject reuse", async () => {
  const { state, port } = fixture();
  state.runs = Array.from({ length: 100 }, () => runMetadata());
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /300-entry bound/u);
  assert.deepEqual(state.effects, []);
  const other = fixture();
  other.state.runs = [runMetadata()];
  other.state.beforeReadRun = () => {
    other.state.runs[0]!.run_attempt = 2;
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], other.port), /attempt changed/u);
});

test("a newer failing request observed during reuse cannot be hidden by older success", async () => {
  const { state, port } = fixture();
  state.runs = [runMetadata()];
  state.beforeReadRun = () => {
    state.runs.push({
      ...runMetadata(),
      id: 103,
      html_url: url.replace("101", "103"),
      conclusion: "failure",
    });
  };
  await assert.rejects(requestFullPrCi(["--pr", "7"], port), /Latest bound CI request changed/u);
  assert.deepEqual(state.effects, []);
});

// RED: a missing branch or a retarget to an equal-SHA branch used to pass the
// SHA-only snapshot guard. Neither can authorize reuse or a PR label mutation.
test("the actual PR base branch is required and returned without a main-only default", async () => {
  for (const ref of [undefined, null, "", 17]) {
    const { state, port } = fixture();
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      const response = await gh(args, timeout);
      return args[1] === "repos/example/tooling/pulls/7"
        ? JSON.stringify({ ...state.pr, base: { ...state.pr.base, ref } })
        : response;
    };
    await assert.rejects(requestFullPrCi(["--pr", "7"], port), /base branch/u);
    assert.deepEqual(state.effects, []);
  }
  const { state, port } = fixture();
  const run = runMetadata();
  state.pr.base.ref = "test/canary";
  run.pull_requests[0]!.base.ref = "test/canary";
  state.runs = [run];
  assert.deepEqual(await requestFullPrCi(["--pr", "7", "--wait"], port), {
    outcome: "ready",
    url,
    head,
    base,
    baseRef: "test/canary",
  });
  assert.deepEqual(state.effects, []);
});

test("equal-SHA base branch retargets before effects, during request, reuse and watch fail closed", async () => {
  for (const phase of ["before-effects", "request", "reuse", "watch"]) {
    const { state, port } = fixture();
    const retarget = () => {
      state.pr.base.ref = "test/canary";
    };
    if (phase === "before-effects") {
      state.pr.labels = [{ name: "ci:full" }];
      const gh = port.gh;
      let reads = 0;
      port.gh = async (args, timeout) => {
        if (args[1] === "repos/example/tooling/pulls/7" && ++reads === 2) {
          retarget();
        }
        return gh(args, timeout);
      };
    } else if (phase === "request") {
      state.beforePost = retarget;
    } else {
      state.runs = [runMetadata()];
      if (phase === "reuse") {
        state.beforeReadRun = retarget;
      } else {
        state.runs[0]!.status = "queued";
        state.watch = retarget;
      }
    }
    await assert.rejects(
      requestFullPrCi(phase === "watch" ? ["--pr", "7", "--wait"] : ["--pr", "7"], port),
      /head\/base changed/u,
      phase,
    );
    assert.equal(state.effects.length, phase === "request" ? 2 : 0, phase);
  }
});

// RED: GitHub can associate the same commit with other PRs; rejecting the entire
// collection used to emit a duplicate request despite one exact requested PR.
test("one exact requested association permits unrelated PR entries in either order", async () => {
  for (const reverse of [false, true]) {
    const { state, port } = fixture();
    const run = runMetadata();
    run.pull_requests.push({
      number: 8,
      head: { sha: "c".repeat(40), ref: "other", repo: { id: 23 } },
      base: { sha: "d".repeat(40), ref: "other-base", repo: { id: 11 } },
    });
    if (reverse) {
      run.pull_requests.reverse();
    }
    state.runs = [run];
    assert.equal((await requestFullPrCi(["--pr", "7", "--wait"], port)).outcome, "ready");
    assert.deepEqual(state.effects, []);
  }
});

test("duplicate or contradictory requested associations cannot be rescued by one matching entry", async () => {
  for (const defect of ["duplicate", "head", "base", "source", "head-ref", "base-ref"]) {
    const { state, port } = fixture();
    const run = runMetadata();
    const extra = structuredClone(run.pull_requests[0]!);
    if (defect === "head") {
      extra.head.sha = "c".repeat(40);
    } else if (defect === "base") {
      extra.base.sha = "c".repeat(40);
    } else if (defect === "source") {
      extra.head.repo.id = 23;
    } else if (defect === "head-ref") {
      extra.head.ref = "other";
    } else if (defect === "base-ref") {
      extra.base.ref = "other";
    }
    run.pull_requests.push(extra);
    state.runs = [run];
    assert.equal((await requestFullPrCi(["--pr", "7"], port)).outcome, "requested", defect);
    assert.equal(state.effects.length, 2, defect);
  }
});

test("an association without an optional base ref retains its exact SHA/source binding", async () => {
  const { state, port } = fixture();
  state.runs = [runMetadata()];
  const gh = port.gh;
  port.gh = async (args, timeout) => {
    const response = await gh(args, timeout);
    if (!args[1]?.includes("/actions/")) {
      return response;
    }
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
    const { state, port } = fixture();
    state.runs = [{ ...runMetadata(), conclusion }];
    const gh = port.gh;
    port.gh = async (args, timeout) => {
      const response = await gh(args, timeout);
      if (args[1]?.includes("/workflows/ci.yml/runs?")) {
        return JSON.stringify({
          workflow_runs: state.runs.map((run) =>
            run.id === 101
              ? { ...run, conclusion: conclusion === "success" ? "failure" : "success" }
              : run,
          ),
        });
      }
      return response;
    };
    assert.equal(
      (await requestFullPrCi(["--pr", "7"], port)).outcome,
      conclusion === "success" ? "ready" : "requested",
    );
    assert.equal(state.effects.length, conclusion === "success" ? 0 : 2);
    if (conclusion === "failure") {
      assert.equal(state.effects[1]![1], "rerun");
    }
  }
});

registerFullCiRecoveryCases();
