import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ProcessTimeoutError } from "../../packages/engineering-foundation/dist/process-execution/api.js";
import { executeManagedProcess } from "../../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { readProcessFailureFacts } from "../../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";

export async function waitForFixtureMarker(
  marker: string,
  fixtureProcess: Promise<unknown>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown = new Error("Fixture marker readiness failed before its first observation.");
  const observation: { settled: boolean; rejection?: { readonly error: unknown } } = {
    settled: false,
  };
  const observedProcess = fixtureProcess.then(
    () => {
      observation.settled = true;
      return true;
    },
    (error: unknown) => {
      observation.settled = true;
      observation.rejection = { error };
      return false;
    },
  );
  while (Date.now() < deadline) {
    if (observation.settled) {
      await observedProcess;
      if (observation.rejection !== undefined) {
        throw observation.rejection.error;
      }
      throw new Error("Fixture process settled before its readiness marker.");
    }
    try {
      await readFile(marker);
      return;
    } catch (error) {
      failure = error;
    }
    await delay(2);
  }
  throw failure;
}

export async function assertCancellationPrecedence(
  childRuntime: string,
  fixtureRoot: string,
): Promise<void> {
  const marker = join(fixtureRoot, `observed-${String(Date.now())}-${String(process.pid)}`);
  const controller = new AbortController();
  const script = [
    "process.on('SIGTERM',()=>process.exit(23));",
    "process.stdout.write('before cancellation');process.stderr.write('failure detail');",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x');`,
    "setTimeout(()=>process.exit(23),1000)",
  ].join("");
  const cancelled = executeManagedProcess({
    command: childRuntime,
    args: ["-e", script],
    cwd: fixtureRoot,
    signal: controller.signal,
  });
  try {
    await waitForFixtureMarker(marker, cancelled);
    controller.abort(new Error("cancel-after-observation"));
    const observed = await cancelled;
    assert.equal(observed.exitCode, 23);
    assert.equal(observed.stdout, "before cancellation");
    assert.equal(observed.stderr, "failure detail");
    assert.deepEqual({ ...readProcessFailureFacts(observed) }, { reason: "exit", exitCode: 23 });
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(new Error("cancel-during-fixture-cleanup"));
    }
    await cancelled.catch(() => {
      return;
    });
    await rm(marker, { force: true });
  }

  await assert.rejects(
    executeManagedProcess({
      command: childRuntime,
      args: [
        "-e",
        "process.on('SIGTERM',()=>process.exit(23));setTimeout(()=>process.exit(23),1000)",
      ],
      cwd: fixtureRoot,
      timeoutMs: 25,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessTimeoutError);
      assert.deepEqual({ ...readProcessFailureFacts(error) }, { reason: "timeout", timeoutMs: 25 });
      return true;
    },
  );
}
