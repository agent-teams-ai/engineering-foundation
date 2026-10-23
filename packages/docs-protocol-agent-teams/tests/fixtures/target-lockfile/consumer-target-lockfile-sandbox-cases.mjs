import { assertFrozenTargetLockInstall } from "./consumer-target-lock-input-assertions.ts";
import { seedTargetLockSandbox } from "./consumer-target-lock-sandbox-fixture.ts";
import { nodeConsumerTargetLockfileReader } from "../../../dist/consumer-integration/adapters/node-consumer-target-lockfile.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import test from "node:test";
import { NodeConsumerUpgradeSandbox } from "../../../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";

import {
  historicalTargetLock,
  candidate,
  digest,
  bytes,
} from "./consumer-target-lockfile-fixture.mjs";

const readConsumerTargetLockfile = nodeConsumerTargetLockfileReader.read;

export function registerTargetLockfileSandboxTests({ desired, cohortV2 }) {
  test("target lock sandbox validates before install, retains selection, freezes preparation and verifies before capture", async (t) => {
    const { root, consumer, path, current, sourceFiles, snapshot, options } =
      await seedTargetLockSandbox(desired, cohortV2);
    const calls = [];
    let tamper = false,
      tamperInstall = false,
      tamperCapture = false,
      failInstall = false;
    let stagedRoot;
    const originalExec = childProcess.execFile;
    t.mock.method(childProcess, "execFile", (executable, args, processOptions, callback) => {
      if (executable === "git" || executable === "tar") {
        if (
          executable === "git" &&
          args[0] === "status" &&
          tamperCapture &&
          stagedRoot !== undefined
        ) {
          // The final source-currentness check runs after staged verification/inventory,
          // immediately before the sandbox reads the operation postimages.
          writeFileSync(
            join(stagedRoot, "pnpm-lock.yaml"),
            Buffer.concat([candidate, Buffer.from("\n")]),
          );
        }
        return originalExec(executable, args, processOptions, callback);
      }
      const cwd = processOptions.cwd;
      const effect = async () => {
        if (executable === "corepack") {
          calls.push([...args]);
          if (failInstall) {
            throw new Error("simulated import failure");
          }
          if (args.includes("--prefer-offline")) {
            stagedRoot = cwd;
            assert.deepEqual(await readFile(join(cwd, "pnpm-lock.yaml")), candidate);
            // Replacing the external input after observation must not substitute staged bytes.
            await writeFile(path, "replaced after validation");
            if (tamperInstall) {
              await writeFile(join(cwd, "pnpm-lock.yaml"), "rewritten by install");
            }
          }
          for (const name of ["docs-protocol-agent-teams", "docs-protocol"]) {
            const cli = join(cwd, "node_modules/@agent-teams", name, "dist/cli.js");
            await mkdir(dirname(cli), { recursive: true });
            await writeFile(cli, "// fixture CLI\n");
          }
        } else {
          if (args[1] === "plan") {
            for (const file of [
              current.skillPath,
              current.callerWorkflowPath,
              current.managedStatePath,
            ]) {
              await writeFile(join(cwd, file), "target asset\n");
            }
            if (tamper) {
              await writeFile(
                join(cwd, "pnpm-lock.yaml"),
                Buffer.concat([candidate, Buffer.from("\n")]),
              );
            }
          }
        }
        return JSON.stringify({ outcome: "current" });
      };
      void effect().then(
        (stdout) => setImmediate(callback, null, stdout, ""),
        (error) => setImmediate(callback, error, "", error.message),
      );
      return;
    });
    syncBuiltinESMExports();
    const sandbox = new NodeConsumerUpgradeSandbox();
    const prepare = async (content) => {
      stagedRoot = undefined;
      await writeFile(path, content);
      return sandbox.prepareV1ToV2({
        ...options,
        targetLockfile: await readConsumerTargetLockfile(
          { path, sha256: digest(content) },
          consumer,
        ),
      });
    };
    try {
      const old = historicalTargetLock();
      await assert.rejects(prepare(bytes(old)), { code: "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH" });
      assert.equal(calls.length, 0);
      await assert.rejects(
        prepare(Buffer.concat([Buffer.from("# foreign comment\n"), candidate])),
        /comments/u,
      );
      assert.equal(calls.length, 0);
      await writeFile(join(consumer, "dirty"), "untracked");
      await assert.rejects(prepare(candidate), { code: "DOCS_CONSUMER_UPGRADE_DIRTY_WORKTREE" });
      await rm(join(consumer, "dirty"));
      await assert.rejects(
        sandbox.prepareV1ToV2({
          ...options,
          expectedSourceSnapshot: {
            ...snapshot,
            lockfile: { ...snapshot.lockfile, bytes: Buffer.from("wrong") },
          },
          targetLockfile: candidate,
        }),
        { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
      );
      assert.equal(calls.length, 0);
      const result = await prepare(candidate);
      const operation = result.operations.find((entry) => entry.path === "pnpm-lock.yaml");
      assert.deepEqual(operation.postimage.bytes, candidate);
      assert.deepEqual(operation.precondition.acceptedPreimages[0].bytes, snapshot.lockfile.bytes);
      assertFrozenTargetLockInstall(calls[0]);
      tamperInstall = true;
      await assert.rejects(prepare(candidate), /bytes changed/u);
      tamperInstall = false;
      tamper = true;
      await assert.rejects(prepare(candidate), /bytes changed/u);
      tamper = false;
      tamperCapture = true;
      await assert.rejects(prepare(candidate), /Captured target lock/u);
      tamperCapture = false;
      await sandbox.activateAndVerifyV2({ authority: options.authority, consumerRoot: consumer });
      await sandbox.restoreAndVerifyV1({ current, consumerRoot: consumer });
      for (const call of calls.slice(-2)) {
        assert.ok(call.includes("--offline"));
        assert.ok(call.includes("--frozen-lockfile"));
        assert.ok(!call.includes("--force"));
      }
      const marker = join(consumer, "node_modules/retained");
      await writeFile(marker, "previous installation");
      failInstall = true;
      await assert.rejects(
        sandbox.restoreAndVerifyV1({ current, consumerRoot: consumer }),
        /simulated import failure/u,
      );
      assert.equal(await readFile(marker, "utf8"), "previous installation");
      for (const [file, content] of Object.values(sourceFiles)) {
        assert.deepEqual(await readFile(join(consumer, file)), content);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}
