import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyDocumentationPlan,
  planDocumentationDocument,
  recoverDocumentationTransaction
} from "../packages/engineering-foundation/dist/document-authoring/index.js";

const fixtures = fileURLToPath(
  new URL("fixtures/document-planning/orchestrator/", import.meta.url)
);
const worker = fileURLToPath(
  new URL("support/document-authoring-crash-worker.mjs", import.meta.url)
);
const requiresStrictDirectoryDurability = process.platform === "win32"
  ? test.skip
  : test;

const automaticallyRecoverable = [
  "after-prepared-journal-durable",
  "after-publishing-journal-durable",
  "after-hard-link",
  "after-publication-synced",
  "after-temporary-cleanup-synced",
  "after-published-journal-durable",
  "after-a1",
  "after-c1",
  "after-a2",
  "after-c2"
];

async function adrPlan(consumerRoot) {
  const { cases, profilePath } = JSON.parse(
    await readFile(join(consumerRoot, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "adr");
  assert.ok(vector);
  return planDocumentationDocument({
    consumerRoot,
    profilePath,
    intent: vector.intent
  });
}

async function crashAt(consumerRoot, plan, checkpoint, scratch) {
  const planPath = join(scratch, `${checkpoint}.json`);
  await writeFile(planPath, `${JSON.stringify(plan)}\n`);
  const child = spawn(process.execPath, [worker, consumerRoot, planPath, checkpoint], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Crash worker did not reach ${checkpoint}. stderr: ${stderr}`));
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
          `Crash worker exited before ${checkpoint}: code=${code} signal=${signal} stderr=${stderr}`
        ));
      }
    });
  });
  assert.equal(child.kill("SIGKILL"), true);
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, null);
  assert.ok(exit.signal === "SIGKILL" || process.platform === "win32");
}

async function withFixture(callback) {
  const scratch = await mkdtemp(join(tmpdir(), "foundation-document-crash-"));
  const consumerRoot = join(scratch, "consumer");
  try {
    await cp(fixtures, consumerRoot, { recursive: true });
    await callback(consumerRoot, scratch);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

for (const checkpoint of automaticallyRecoverable) {
  requiresStrictDirectoryDurability(`SIGKILL at ${checkpoint} is recovered to an exact receipt`, async () => {
    await withFixture(async (consumerRoot, scratch) => {
      const plan = await adrPlan(consumerRoot);
      await crashAt(consumerRoot, plan, checkpoint, scratch);
      const receipt = await recoverDocumentationTransaction({ consumerRoot });
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.planDigest, plan.planDigest);
      assert.equal(receipt.resultDigest, plan.output.digest);
      assert.equal(await readFile(join(consumerRoot, plan.destination), "utf8"),
        Buffer.from(plan.output.contentBase64, "base64").toString("utf8"));
      const replay = await applyDocumentationPlan({ consumerRoot, plan });
      assert.equal(replay.outcome, "already-applied");
    });
  });
}

requiresStrictDirectoryDurability("SIGKILL after temporary sync preserves orphan evidence for manual recovery", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await adrPlan(consumerRoot);
    await crashAt(consumerRoot, plan, "after-temporary-synced", scratch);
    const receipt = await recoverDocumentationTransaction({ consumerRoot });
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.match(receipt.diagnostics[0].ruleId, /orphan-temporary/u);
    await assert.rejects(
      applyDocumentationPlan({ consumerRoot, plan }),
      /must be recovered/u
    );
  });
});

requiresStrictDirectoryDurability("SIGKILL after durable journal removal loses only the receipt and exact replay closes it", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await adrPlan(consumerRoot);
    await crashAt(
      consumerRoot,
      plan,
      "after-final-journal-removal-synced",
      scratch
    );
    await assert.rejects(
      recoverDocumentationTransaction({ consumerRoot }),
      /requires a coordinator-qualified recoverable transaction/u
    );
    const replay = await applyDocumentationPlan({ consumerRoot, plan });
    assert.equal(replay.outcome, "already-applied");
    assert.equal(replay.resultDigest, plan.output.digest);
  });
});
