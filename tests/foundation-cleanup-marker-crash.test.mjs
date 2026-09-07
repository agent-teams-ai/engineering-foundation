import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";

const worker = fileURLToPath(new URL(
  "support/foundation-cleanup-marker-crash-worker.mjs",
  import.meta.url
));
const posixTest = process.platform === "win32" ? test.skip : test;
const residuePrefix = "foundation-transaction.cleanup-residue.";

async function crashAt(root, checkpoint) {
  const child = spawn(process.execPath, [worker, root, checkpoint], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Marker worker timed out at ${checkpoint}: ${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes(`CHECKPOINT:${checkpoint}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!stdout.includes(`CHECKPOINT:${checkpoint}\n`)) {
        clearTimeout(timeout);
        reject(new Error(
          `Marker worker exited early: code=${code} signal=${signal} stderr=${stderr}`
        ));
      }
    });
  });
  assert.equal(child.kill("SIGKILL"), true);
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
}

for (const checkpoint of [
  "after-marker-synced",
  "after-marker-retirement-synced"
]) {
  posixTest(`SIGKILL at ${checkpoint} leaves a global marker-only mutation barrier`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-cleanup-marker-crash-"));
    try {
      await crashAt(root, checkpoint);
      const state = join(root, ".agent-teams-local");
      const entries = await readdir(state);
      assert.equal(entries.includes("scaffolding-transaction.json"), false);
      assert.ok(entries.some((entry) => entry.startsWith(residuePrefix)));

      const coordinator = await createNodeFoundationTransactionCoordinator(root);
      const status = await coordinator.inspect();
      assert.equal(status.state, "manual-recovery-required");
      assert.equal(status.reason, "journal-transition-residue");
      await assert.rejects(
        coordinator.acquire({ requestedMutation: "document-authoring" }),
        /incomplete Foundation transaction transition/u
      );

      for (const entry of entries.filter((name) => name.startsWith(residuePrefix))) {
        await lstat(join(state, entry));
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
}
