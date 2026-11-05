import assert from "node:assert/strict";
import test from "node:test";
import { settleLocalOperation } from "../packages/engineering-foundation/dist/local-mode/application/settle-local-operation.js";
import { FoundationError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { ProcessCancellationError } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { foundationCommandFailure } from "../packages/engineering-foundation/dist/features/command-host/application/command-failure.js";

test("local settlement preserves each sole failure without changing thrown values", async () => {
  for (const failure of [
    Object.freeze(new Error("frozen failure")),
    undefined,
    null,
    "non-error failure",
  ]) {
    let finalized = 0;
    await assert.rejects(
      settleLocalOperation(
        async () => {
          throw failure;
        },
        async () => {
          finalized++;
        },
      ),
      (actual: unknown) => actual === failure,
    );
    assert.equal(finalized, 1);
    await assert.rejects(
      settleLocalOperation(
        async () => "complete",
        async () => {
          throw failure;
        },
      ),
      (actual: unknown) => actual === failure,
    );
  }
});

test("local settlement retains ordered operation and finalization failures including cancellation", async () => {
  const cause = Object.freeze(new Error("nested operation cause"));
  const release = Object.freeze(new Error("unsettled release"));
  for (const original of [
    Object.freeze(new Error("operation", { cause })),
    Object.freeze(new ProcessCancellationError("cancelled")),
    undefined,
    "non-error",
  ]) {
    let finalizations = 0;
    await assert.rejects(
      settleLocalOperation(
        async () => {
          throw original;
        },
        async () => {
          finalizations++;
          throw release;
        },
      ),
      (failure: unknown) => {
        assert.ok(failure instanceof FoundationError);
        assert.equal(failure.code, "LOCAL_STATE_INVALID");
        assert.ok(failure.cause instanceof AggregateError);
        assert.deepEqual(failure.cause.errors, [original, release]);
        assert.equal(foundationCommandFailure(failure).exitCode, 1);
        assert.equal(foundationCommandFailure(failure).envelope.outcome, "execution-failure");
        return true;
      },
    );
    assert.equal(finalizations, 1);
  }
});

test("local settlement returns the exact result only after finalization", async () => {
  const result = Object.freeze({ state: "done" });
  const events: string[] = [];
  assert.equal(
    await settleLocalOperation(
      async () => {
        events.push("operation");
        return result;
      },
      async () => {
        events.push("release");
      },
    ),
    result,
  );
  assert.deepEqual(events, ["operation", "release"]);
});
