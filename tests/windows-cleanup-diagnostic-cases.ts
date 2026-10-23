import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { foundationCommandFailure } from "../packages/engineering-foundation/dist/features/command-host/adapters/inbound/cli/command-error.js";
import {
  describeManagedProcessCleanupFailure,
  managedProcessCleanupFailure,
} from "../packages/engineering-foundation/dist/process-execution/windows-managed-process-diagnostics.js";

export function registerWindowsCleanupDiagnosticCases(): void {
  // A one-shot EBUSY or EPERM turns red with single-attempt cleanup, including
  // after a delayed wrapper exit. Persistent EBUSY turns red for unbounded
  // retries or a forgotten root. EACCES turns red if a permanent error is retried.
  for (const [failureCode, failures, expectedAttempts, expectedRootExists] of [
    ["EBUSY", 1, 2, false],
    ["EPERM", 1, 2, false],
    ["ENOTEMPTY", 1, 2, false],
    ["EBUSY", 100, 4, true],
    ["EACCES", 100, 1, true],
  ]) {
    for (const path of ["immediate", "deferred"]) {
      void test(`bounds ${path} Windows control-root cleanup after ${String(failures)} ${failureCode} failure(s)`, () => {
        const source = `
        import fs from "node:fs";
        import childProcess from "node:child_process";
        import { EventEmitter } from "node:events";
        import { syncBuiltinESMExports } from "node:module";
        const remove = fs.rmSync;
        const spawn = childProcess.spawn;
        let attempts = 0;
        let controlRoot;
        let child;
        fs.rmSync = (path, options) => {
          controlRoot = path;
          attempts += 1;
          if (attempts <= ${String(failures)}) {
            throw Object.assign(new Error("injected cleanup failure"), { code: ${JSON.stringify(failureCode)} });
          }
          return remove(path, options);
        };
        if (${JSON.stringify(path)} === "deferred") {
          childProcess.spawn = () => {
            child = new EventEmitter();
            child.stdin = null;
            child.exitCode = null;
            child.signalCode = null;
            child.pid = 123;
            child.kill = () => true;
            return child;
          };
        }
        syncBuiltinESMExports();
        const { spawnWindowsManagedProcess } = await import(
          "./packages/engineering-foundation/dist/process-execution/windows-managed-process.js"
        );
        try {
          spawnWindowsManagedProcess({
            command: process.execPath,
            args: [],
            cwd: process.cwd(),
            launcherEnvironment: { SystemRoot: ${JSON.stringify(path === "immediate" ? "relative-system-root" : "C:\\Windows")} }
          });
          throw new Error("expected launch failure");
        } catch (error) {
          if (!String(error).includes(${JSON.stringify(path === "immediate" ? "SystemRoot must be an absolute Windows path" : "did not expose its bootstrap input")})) {
            throw error;
          }
        }
        if (child) {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }
        fs.rmSync = remove;
        childProcess.spawn = spawn;
        syncBuiltinESMExports();
        const rootExists = fs.existsSync(controlRoot);
        if (rootExists) remove(controlRoot, { force: true, recursive: true });
        process.stdout.write(JSON.stringify({ attempts, rootExists }));
      `;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          attempts: expectedAttempts,
          rootExists: expectedRootExists,
        });
      });
    }
  }

  void test("reports bounded Windows cleanup diagnostics without exposing wrapper output", () => {
    const timeout = new Error(
      "Windows Job Object wrapper did not confirm containment within 30000 ms.",
    );
    const diagnostic = describeManagedProcessCleanupFailure(
      new AggregateError([new Error("outer cleanup failure"), timeout], "cleanup failed"),
      [
        Buffer.from(
          [
            "private child output",
            "Windows Job Object runner failed [phase=managed-run]: private failure detail",
          ].join("\n"),
        ),
      ],
      true,
    );
    assert.equal(
      diagnostic,
      "could not clean up its process tree after exit. [windows-containment=wrapper-confirmation-timeout;wrapper-phase=managed-run]",
    );
    assert.doesNotMatch(diagnostic, /private/u);
  });

  void test("classifies allowlisted Windows confirmation read codes only", () => {
    const busy = Object.assign(new Error("private control path"), { code: "EBUSY" });
    assert.equal(
      describeManagedProcessCleanupFailure(busy, [Buffer.from("arbitrary output")], true),
      "could not clean up its process tree after exit. [windows-containment=confirmation-read-EBUSY;wrapper-phase=unreported]",
    );
    const privateCode = Object.assign(new Error("private failure"), { code: "SECRET" });
    assert.equal(
      describeManagedProcessCleanupFailure(privateCode, [Buffer.from("private output")], true),
      "could not clean up its process tree after exit. [windows-containment=unknown;wrapper-phase=unreported]",
    );
    assert.equal(
      describeManagedProcessCleanupFailure(privateCode, [Buffer.from("private output")], false),
      "could not clean up its process tree after exit.",
    );
  });

  void test("bounds hostile cleanup diagnostics and selects the final wrapper phase", () => {
    const cycle = new AggregateError([], "cycle");
    cycle.errors.push(cycle);
    Object.defineProperty(cycle, "cause", {
      get() {
        throw new Error("private throwing cause");
      },
    });
    const throwingErrors = new AggregateError([], "private aggregate");
    Object.defineProperty(throwingErrors, "errors", {
      get() {
        throw new Error("private throwing errors");
      },
    });
    assert.equal(
      describeManagedProcessCleanupFailure(
        new AggregateError([cycle, throwingErrors], "private root"),
        [
          Buffer.from(
            [
              "Windows Job Object runner failed [phase=helper-compile]: child spoof",
              "Windows Job Object runner failed [phase=managed-run]: wrapper failure",
            ].join("\n"),
          ),
        ],
        true,
      ),
      "could not clean up its process tree after exit. [windows-containment=unknown;wrapper-phase=managed-run]",
    );
  });

  void test("preserves bounded Windows cleanup diagnostics in the command envelope", () => {
    const cleanupFailure = managedProcessCleanupFailure(
      { command: "private-command".repeat(100), args: [], cwd: process.cwd() },
      new Error("Windows Job Object wrapper exited before it confirmed process containment."),
      [],
      true,
    );
    const failure = foundationCommandFailure(cleanupFailure);
    assert.equal(failure.envelope.error.message.length, 1000);
    assert.match(
      failure.envelope.error.message,
      /^could not clean up its process tree after exit\. \[windows-containment=wrapper-exited-before-confirmation;wrapper-phase=unreported\]/u,
    );
  });
}
