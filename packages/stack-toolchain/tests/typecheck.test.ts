import assert from "node:assert/strict";
import { test } from "node:test";
import { typecheck } from "../src/features/toolchain-execution/application/typecheck.ts";
import type { AttemptInput, AttemptOutcome, AttemptResult } from "../src/features/toolchain-execution/application/typecheck.ts";

const settled = (outcome: AttemptOutcome, changes: Partial<AttemptResult> = {}): AttemptResult =>
  ({ outcome, captureComplete: true, cleanupComplete: true, diagnostics: [], ...changes });

function harness(results: readonly AttemptResult[]) {
  const calls: AttemptInput[] = [];
  let time = 0;
  return { calls, advance: (ms: number) => { time += ms; }, dependencies: {
    now: () => time,
    run: async (input: AttemptInput) => {
      calls.push(input);
      const result = results[calls.length - 1];
      assert.ok(result, "unexpected extra checker invocation");
      return result;
    }
  } };
}
const input = () => ({ projects: ["first.json", "second.json", "third.json"],
  signal: new AbortController().signal });

test("primary success never invokes either fallback", async () => {
  const h = harness([settled({ kind: "passed" })]);
  assert.equal((await typecheck(input(), h.dependencies)).status, "passed");
  assert.deepEqual(h.calls.map(call => call.engine), ["tsrs"]);
});

test("fallback starts the complete group and stops after Bun success", async () => {
  const h = harness([settled({ kind: "engine-failure", reason: "qualified crash" }),
    settled({ kind: "passed" })]);
  const result = await typecheck(input(), h.dependencies);
  assert.equal(result.status, "passed-with-fallback");
  assert.deepEqual(h.calls.map(call => call.engine), ["tsrs", "bun"]);
  assert.deepEqual(h.calls.map(call => call.projects), [input().projects, input().projects]);
});

test("official compiler is reached only after both earlier refusals", async () => {
  const h = harness([settled({ kind: "unavailable", reason: "platform" }),
    settled({ kind: "engine-failure", reason: "qualified crash" }), settled({ kind: "passed" })]);
  assert.equal((await typecheck(input(), h.dependencies)).status, "passed-with-fallback");
  assert.deepEqual(h.calls.map(call => call.engine), ["tsrs", "bun", "typescript"]);
});

for (const outcome of [{ kind: "diagnostics", output: "TS2322" },
  { kind: "unclassified", reason: "unknown exit 2" }, { kind: "cancelled" }] as const) {
  test(`${outcome.kind} never invokes a fallback`, async () => {
    const h = harness([settled(outcome)]);
    assert.equal((await typecheck(input(), h.dependencies)).status, "failed");
    assert.equal(h.calls.length, 1);
  });
}

test("diagnostic followed by timeout remains terminal", async () => {
  const h = harness([settled({ kind: "timeout" }, { diagnostics: ["TS2322"] })]);
  const result = await typecheck(input(), h.dependencies);
  assert.equal(result.status === "failed" && result.code, "TOOLCHAIN_DIAGNOSTICS");
  assert.equal(h.calls.length, 1);
});

for (const changes of [{ captureComplete: false }, { cleanupComplete: false }]) {
  test(`incomplete settlement ${JSON.stringify(changes)} is terminal`, async () => {
    const h = harness([settled({ kind: "engine-failure", reason: "crash" }, changes)]);
    assert.equal((await typecheck(input(), h.dependencies)).status, "failed");
    assert.equal(h.calls.length, 1);
  });
}

test("total deadline is shared across attempts", async () => {
  const h = harness([]);
  const calls: AttemptInput[] = [];
  const result = await typecheck({ ...input(), budgetMs: 150, attemptBudgetMs: 100 }, {
    now: h.dependencies.now,
    run: async call => {
      calls.push(call);
      h.advance(100);
      return settled({ kind: "timeout" });
    }
  });
  assert.deepEqual(calls.map(call => call.deadline), [100, 150]);
  assert.equal(result.status === "failed" && result.code, "TOOLCHAIN_DEADLINE");
});

test("pre-cancelled command starts no checker", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness([]);
  assert.equal((await typecheck({ ...input(), signal: controller.signal }, h.dependencies)).status, "failed");
  assert.equal(h.calls.length, 0);
});

test("an adapter exception cannot become a green fallback", async () => {
  const result = await typecheck(input(), { now: () => 0, run: async () => { throw new Error("unknown"); } });
  assert.equal(result.status === "failed" && result.code, "TOOLCHAIN_UNCLASSIFIED_FAILURE");
});
