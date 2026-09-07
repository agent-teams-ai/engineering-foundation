import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  planDocumentationDocument
} from "../packages/document-authoring/dist/index.js";
import { NodeDocumentFileState } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-file-state.js";

const fixtures = fileURLToPath(
  new URL("fixtures/document-planning/orchestrator/", import.meta.url)
);
const worker = fileURLToPath(
  new URL("support/document-authoring-concurrency-worker.mjs", import.meta.url)
);
const requiresStrictDirectoryDurability = process.platform === "win32"
  ? test.skip
  : test;

async function withFixture(callback) {
  const scratch = await mkdtemp(join(tmpdir(), "foundation-document-concurrency-"));
  const consumerRoot = join(scratch, "consumer");
  try {
    await cp(fixtures, consumerRoot, { recursive: true });
    await callback(consumerRoot, scratch);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function competingPlans(consumerRoot) {
  const { cases, profilePath } = JSON.parse(
    await readFile(join(consumerRoot, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "adr");
  assert.ok(vector);
  const first = await planDocumentationDocument({
    consumerRoot,
    profilePath,
    intent: vector.intent
  });
  const second = await planDocumentationDocument({
    consumerRoot,
    profilePath,
    intent: {
      ...vector.intent,
      title: "Concurrent alternative",
      summary: "Competes for the exact same destination with different bytes."
    }
  });
  assert.equal(first.destination, second.destination);
  assert.notEqual(first.output.digest, second.output.digest);
  return [first, second];
}

function startWorker(consumerRoot, planPath, checkpoint = "none") {
  const child = spawn(
    process.execPath,
    [worker, consumerRoot, planPath, checkpoint],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffered = "";
  let stderr = "";
  const messages = [];
  const waiters = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter === undefined) {
        messages.push(message);
      } else {
        waiter.resolve(message);
      }
    }
  });
  child.once("error", (error) => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  });
  return {
    child,
    nextMessage() {
      const message = messages.shift();
      if (message !== undefined) {
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Writer worker timed out. stderr: ${stderr}`));
        }, 20_000);
        waiters.push({
          reject,
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          }
        });
      });
    },
    release() {
      child.stdin.end("release\n");
    },
    async exit() {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      return { ...result, stderr };
    }
  };
}

async function writePlan(scratch, name, plan) {
  const path = join(scratch, `${name}.json`);
  await writeFile(path, `${JSON.stringify(plan)}\n`);
  return path;
}

async function assertNoTransactionResidue(consumerRoot) {
  const stateDirectory = join(consumerRoot, ".agent-teams-local");
  const entries = await readdir(stateDirectory).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  assert.deepEqual(
    entries.filter((entry) =>
      !entry.startsWith("foundation-operation.lock.released.") &&
      entry !== "foundation-operation-lock.completed-evidence" &&
      entry !== "scaffolding-transaction.json.completed-document-evidence"),
    []
  );
}

for (const winnerIndex of [0, 1]) {
  requiresStrictDirectoryDurability(`independent writers preserve exact-vs-conflict truth when plan ${winnerIndex + 1} wins`, async () => {
    await withFixture(async (consumerRoot, scratch) => {
      const plans = await competingPlans(consumerRoot);
      const loserIndex = 1 - winnerIndex;
      const planPaths = await Promise.all([
        writePlan(scratch, "plan-1", plans[0]),
        writePlan(scratch, "plan-2", plans[1])
      ]);

      const winner = startWorker(
        consumerRoot,
        planPaths[winnerIndex],
        "after-prepared-journal-durable"
      );
      assert.deepEqual(await winner.nextMessage(), {
        checkpoint: "after-prepared-journal-durable"
      });

      const racingLoser = startWorker(consumerRoot, planPaths[loserIndex]);
      const raced = await racingLoser.nextMessage();
      assert.equal(
        raced.error,
        "Another repository mutation operation is active or its lock is not safely recoverable."
      );
      assert.deepEqual(await racingLoser.exit(), {
        code: 1,
        signal: null,
        stderr: ""
      });

      winner.release();
      const won = await winner.nextMessage();
      assert.equal(won.receipt.outcome, "applied");
      assert.equal(won.receipt.resultDigest, plans[winnerIndex].output.digest);
      assert.deepEqual(await winner.exit(), {
        code: 0,
        signal: null,
        stderr: ""
      });

      const exactReplay = startWorker(consumerRoot, planPaths[winnerIndex]);
      const replayed = await exactReplay.nextMessage();
      assert.equal(replayed.receipt.outcome, "already-applied");
      assert.equal(replayed.receipt.resultDigest, plans[winnerIndex].output.digest);
      assert.equal((await exactReplay.exit()).code, 0);

      const fileState = new NodeDocumentFileState();
      assert.equal(
        (await fileState.classifyDestination({
          consumerRoot,
          plan: plans[winnerIndex]
        })).state,
        "exact"
      );
      assert.equal(
        (await fileState.classifyDestination({
          consumerRoot,
          plan: plans[loserIndex]
        })).state,
        "conflict"
      );

      const conflictReplay = startWorker(consumerRoot, planPaths[loserIndex]);
      const conflicted = await conflictReplay.nextMessage();
      assert.equal(conflicted.receipt.outcome, "authority-stale");
      assert.equal(
        conflicted.receipt.diagnostics[0].ruleId,
        "document.transaction.authority-stale"
      );
      assert.equal((await conflictReplay.exit()).code, 0);

      assert.deepEqual(
        await readFile(join(consumerRoot, plans[winnerIndex].destination)),
        Buffer.from(plans[winnerIndex].output.contentBase64, "base64")
      );
      await assertNoTransactionResidue(consumerRoot);
    });
  });
}
