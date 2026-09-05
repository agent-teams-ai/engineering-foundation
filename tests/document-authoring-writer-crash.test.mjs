import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyDocumentationPlan,
  inspectDocumentTransactionV2,
  planDocumentationDocument,
  recoverDocumentationTransaction
} from "../packages/document-authoring/dist/index.js";
import { documentTemporaryPath } from "../packages/document-authoring/dist/application/policies/document-temporary-path.js";
import { createNodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-slot.js";

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

async function featurePlanV2(consumerRoot) {
  const { cases, profilePath } = JSON.parse(
    await readFile(join(consumerRoot, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "feature");
  assert.ok(vector);
  const source = await readFile(join(consumerRoot, profilePath), "utf8");
  await writeFile(join(consumerRoot, profilePath), source
    .replace("schemaVersion: 1", "schemaVersion: 2")
    .replaceAll(/(    - type: [^\n]+\n)/gu,
      "$1      allowedOwnerIds: [architecture/tooling, example/create-widget]\n")
    .replace("reachability: {kind: not-required}",
      "reachability: {kind: not-required, reason: indexed by bounded-context hierarchy}"));
  await rm(join(consumerRoot, "packages/example/src/features/create-widget"), {
    force: true,
    recursive: true
  });
  return planDocumentationDocument({
    consumerRoot,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
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

requiresStrictDirectoryDurability("envelope v4 is publicly inspectable and recovers before mkdir", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await featurePlanV2(consumerRoot);
    await crashAt(
      consumerRoot,
      plan,
      "after-materializing-journal-durable",
      scratch
    );
    const inspection = await inspectDocumentTransactionV2(consumerRoot);
    assert.equal(inspection.state, "recoverable");
    assert.equal(inspection.format, "document-authoring-envelope-v4");
    const receipt = await recoverDocumentationTransaction({ consumerRoot });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.commit.fileAtomicity, "single-file-atomic-create");
    assert.deepEqual(
      receipt.directoryMaterialization.observedCreatedDirectories,
      plan.parentMaterialization.missingDirectories
    );
  });
});

for (const checkpoint of ["after-publishing-journal-durable", "after-hard-link"]) {
  requiresStrictDirectoryDurability(`envelope v4 recovers exactly at ${checkpoint}`, async () => {
    await withFixture(async (consumerRoot, scratch) => {
      const plan = await featurePlanV2(consumerRoot);
      await crashAt(consumerRoot, plan, checkpoint, scratch);
      const inspection = await inspectDocumentTransactionV2(consumerRoot);
      assert.equal(inspection.state, "recoverable");
      assert.equal(inspection.format, "document-authoring-envelope-v4");
      const receipt = await recoverDocumentationTransaction({ consumerRoot });
      assert.equal(receipt.schemaVersion, 2);
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.directoryMaterialization.state, "created-and-retained");
      assert.deepEqual(
        receipt.directoryMaterialization.observedCreatedDirectories,
        plan.parentMaterialization.missingDirectories
      );
    });
  });
}

requiresStrictDirectoryDurability("v4 post-link recovery uses the persisted Plan after profile removal", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await featurePlanV2(consumerRoot);
    await crashAt(consumerRoot, plan, "after-hard-link", scratch);
    const { profilePath } = JSON.parse(
      await readFile(join(consumerRoot, "cases.json"), "utf8")
    );
    await rm(join(consumerRoot, profilePath));
    const receipt = await recoverDocumentationTransaction({ consumerRoot });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.resultDigest, plan.output.digest);
  });
});

requiresStrictDirectoryDurability("v4 PREPARED without its profile preserves recovery evidence", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await featurePlanV2(consumerRoot);
    await crashAt(consumerRoot, plan, "after-prepared-journal-durable", scratch);
    const { profilePath } = JSON.parse(
      await readFile(join(consumerRoot, "cases.json"), "utf8")
    );
    await rm(join(consumerRoot, profilePath));
    const receipt = await recoverDocumentationTransaction({ consumerRoot });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.outcome, "recovery-required");
    assert.equal(receipt.commit.publication, "none");
    assert.equal((await inspectDocumentTransactionV2(consumerRoot)).state, "recoverable");
    await assert.rejects(readFile(join(consumerRoot, plan.destination)));
  });
});

requiresStrictDirectoryDurability("Foundation leaves native v4 recovery to Authoring regardless of Foundation version/build", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await featurePlanV2(consumerRoot);
    await crashAt(consumerRoot, plan, "after-prepared-journal-durable", scratch);
    const envelope = JSON.parse(await readFile(join(
      consumerRoot,
      ".agent-teams-local",
      "scaffolding-transaction.json"
    ), "utf8"));
    const exact = await createNodeFoundationTransactionSlot({
      consumerRoot,
      installedVersion: envelope.foundation.version,
      installedBuildIdentity: envelope.foundation.buildIdentity
    }).inspect();
    assert.equal(exact.state, "manual-recovery-required");
    assert.equal(exact.recovery, undefined);
    assert.match(exact.diagnostics[0]?.message, /Claimed @agent-teams\/document-authoring/u);
    for (const installed of [
      {
        version: "0.0.0-wrong",
        buildIdentity: envelope.foundation.buildIdentity
      },
      {
        version: envelope.foundation.version,
        buildIdentity: `sha256:${"9".repeat(64)}`
      }
    ]) {
      const mismatch = await createNodeFoundationTransactionSlot({
        consumerRoot,
        installedVersion: installed.version,
        installedBuildIdentity: installed.buildIdentity
      }).inspect();
      assert.deepEqual(mismatch, exact);
    }
  });
});

requiresStrictDirectoryDurability("mkdir-before-journal crash is manual-only and never adopted", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await featurePlanV2(consumerRoot);
    await crashAt(
      consumerRoot,
      plan,
      "after-directory-created-before-journal",
      scratch
    );
    const inspection = await inspectDocumentTransactionV2(consumerRoot);
    assert.equal(inspection.state, "recoverable");
    assert.equal(inspection.format, "document-authoring-envelope-v4");
    const receipt = await recoverDocumentationTransaction({ consumerRoot });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.equal(receipt.directoryMaterialization.state, "preserved-unknown");
  });
});

requiresStrictDirectoryDurability("SIGKILL after temporary sync preserves orphan evidence for manual recovery", async () => {
  await withFixture(async (consumerRoot, scratch) => {
    const plan = await adrPlan(consumerRoot);
    await crashAt(consumerRoot, plan, "after-temporary-synced", scratch);
    const receipt = await recoverDocumentationTransaction({ consumerRoot });
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.match(receipt.diagnostics[0].ruleId, /orphan-temporary/u);
    const blocked = await applyDocumentationPlan({ consumerRoot, plan });
    assert.equal(blocked.outcome, "manual-recovery-required");
    assert.equal(
      blocked.diagnostics[0].ruleId,
      "document.transaction.cleanup-unproven"
    );
    assert.deepEqual(
      await readFile(join(
        consumerRoot,
        documentTemporaryPath(plan.destination, plan.planDigest)
      )),
      Buffer.from(plan.output.contentBase64, "base64")
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
