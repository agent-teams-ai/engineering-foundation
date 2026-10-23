import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SUPPORTED_NODE_VERSIONS } from "../packages/engineering-foundation/dist/process-execution/node-runtime-verifier.js";
import { executeManagedProcess } from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import {
  ProcessCancellationError,
  ProcessTimeoutError,
} from "../packages/engineering-foundation/dist/process-execution/api.js";
import { readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";

export function registerProcessRuntimeProtocolCases(
  fixtureRoot: string,
  childRuntime: string,
): void {
  // Public engines and the Host admission policy must evolve in the same change.
  void test("Node admission versions match both published and repository engines", async () => {
    const expected = SUPPORTED_NODE_VERSIONS.map(
      ({ major, minimumMinor }) => `^${major}.${minimumMinor}.0`,
    ).join(" || ");
    for (const path of ["../package.json", "../packages/engineering-foundation/package.json"]) {
      const manifest = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as {
        engines: { node: string };
      };
      assert.equal(manifest.engines.node, expected);
    }
  });

  // Trusted control markers, rather than the wrapper exit or captured stderr,
  // distinguish a command launch failure from an ordinary command failure.
  void test(
    "Windows launch handshake preserves exit-one commands and startup deadlines",
    {
      skip: process.platform !== "win32" ? "native Windows handshake" : false,
      timeout: 30_000,
    },
    async () => {
      const result = await executeManagedProcess({
        command: childRuntime,
        args: [
          "-e",
          "process.stderr.write('Managed command could not be started: FAILED');process.exitCode=1",
        ],
        cwd: fixtureRoot,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(readProcessFailureFacts(result)?.reason, "exit");
      await assert.rejects(
        executeManagedProcess({
          command: childRuntime,
          args: ["-e", "setTimeout(()=>{},60000)"],
          cwd: fixtureRoot,
          timeoutMs: 10,
        }),
        ProcessTimeoutError,
      );
      const cancellation = new AbortController();
      const cancelTimer = setTimeout(
        () => cancellation.abort(new Error("earlier Windows cancellation")),
        1,
      );
      try {
        await assert.rejects(
          executeManagedProcess({
            command: childRuntime,
            args: ["-e", "setTimeout(()=>{},60000)"],
            cwd: fixtureRoot,
            timeoutMs: 5,
            signal: cancellation.signal,
          }),
          ProcessCancellationError,
        );
      } finally {
        clearTimeout(cancelTimer);
      }
    },
  );

  void test("Windows command launch protocol validates markers and yields interrupted waits", async () => {
    const { waitForWindowsCommandLaunch } =
      await import("../packages/engineering-foundation/dist/process-execution/windows-command-launch.js");
    const root = mkdtempSync(join(fixtureRoot, "launch-protocol-"));
    const marker = join(root, "launched");
    const child = { exitCode: null, signalCode: null };
    await writeFile(marker, "STARTED");
    await waitForWindowsCommandLaunch(child, marker, () => false);
    await writeFile(marker, "FAILED");
    await assert.rejects(
      waitForWindowsCommandLaunch(child, marker, () => false),
      /could not be started/u,
    );
    await writeFile(marker, "unrecognized");
    await assert.rejects(
      waitForWindowsCommandLaunch(child, marker, () => false),
      /invalid launch confirmation/u,
    );
    await rm(marker);
    let polls = 0;
    await waitForWindowsCommandLaunch(child, marker, () => ++polls >= 2);
    assert.equal(polls, 2);
    await assert.rejects(
      waitForWindowsCommandLaunch({ exitCode: 1, signalCode: null }, marker, () => false),
      /without a command launch confirmation/u,
    );
  });
}
