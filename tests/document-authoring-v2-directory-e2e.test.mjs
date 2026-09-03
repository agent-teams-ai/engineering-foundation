import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyDocumentationPlan,
  inspectDocumentTransactionV2,
  planDocumentationDocument
} from "../packages/document-authoring/dist/index.js";
import { applyNodeDocumentationPlanPrivately } from "../packages/document-authoring/dist/composition/node-document-writing-private.js";

const fixtures = fileURLToPath(
  new URL("fixtures/document-planning/orchestrator/", import.meta.url)
);

const qualified = process.platform === "win32" ? test.skip : test;

async function upgradeProfileV2(root) {
  const path = join(root, "document-authoring.yaml");
  const source = await readFile(path, "utf8");
  await writeFile(path, source
    .replace("schemaVersion: 1", "schemaVersion: 2")
    .replaceAll(/(    - type: [^\n]+\n)/gu,
      "$1      allowedOwnerIds: [architecture/tooling, example/create-widget]\n")
    .replace("reachability: {kind: not-required}",
      "reachability: {kind: not-required, reason: indexed by bounded-context hierarchy}"));
}

qualified("Plan v2 materializes a missing parent chain and applies through envelope v4", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-v2-e2e-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtures, root, { recursive: true });
  await upgradeProfileV2(root);
  await rm(join(root, "packages/example/src/features/create-widget"), {
    recursive: true
  });
  const { cases, profilePath } = JSON.parse(
    await readFile(join(root, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "feature");
  const plan = await planDocumentationDocument({
    consumerRoot: root,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
  });
  assert.equal(plan.schemaVersion, 2);
  assert.deepEqual(plan.parentMaterialization, {
    deepestExistingDirectory: "packages/example/src/features",
    finalParent: "packages/example/src/features/create-widget",
    missingDirectories: ["packages/example/src/features/create-widget"],
    policy: "create-missing-real-directories"
  });
  const receipt = await applyDocumentationPlan({ consumerRoot: root, plan });
  assert.equal(receipt.outcome, "applied");
  assert.equal(
    await readFile(join(root, plan.destination), "utf8"),
    Buffer.from(plan.output.contentBase64, "base64").toString("utf8")
  );
  const replay = await applyDocumentationPlan({ consumerRoot: root, plan });
  assert.equal(replay.outcome, "already-applied");
});

qualified("a second directory-step failure retains exact bound evidence without deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-v2-step2-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtures, root, { recursive: true });
  await upgradeProfileV2(root);
  await rm(join(root, "packages/example/src/features"), { recursive: true });
  const { cases, profilePath } = JSON.parse(
    await readFile(join(root, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "feature");
  const plan = await planDocumentationDocument({
    consumerRoot: root,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
  });
  assert.equal(plan.parentMaterialization.missingDirectories.length, 2);
  let durableSteps = 0;
  const receipt = await applyNodeDocumentationPlanPrivately(
    { consumerRoot: root, plan },
    {
      faultInjector(point) {
        if (point.phase === "after-materializing-journal-durable" &&
          ++durableSteps === 2) {
          throw new Error("step-two-injected");
        }
      }
    }
  );
  assert.equal(
    receipt.outcome,
    "failed-before-publication",
    JSON.stringify(receipt)
  );
  assert.equal(receipt.directoryMaterialization.state, "created-and-retained");
  assert.deepEqual(receipt.directoryMaterialization.observedCreatedDirectories, [
    plan.parentMaterialization.missingDirectories[0]
  ]);
});

qualified("abort after the first durable bind retains it and never starts the second directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-v2-cancel-step-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtures, root, { recursive: true });
  await upgradeProfileV2(root);
  await rm(join(root, "packages/example/src/features"), { recursive: true });
  const { cases, profilePath } = JSON.parse(
    await readFile(join(root, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "feature");
  const plan = await planDocumentationDocument({
    consumerRoot: root,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
  });
  assert.equal(plan.parentMaterialization.missingDirectories.length, 2);
  const controller = new AbortController();
  let durableSteps = 0;
  const receipt = await applyNodeDocumentationPlanPrivately(
    { consumerRoot: root, plan, signal: controller.signal },
    {
      faultInjector(point) {
        if (point.phase === "after-materializing-journal-durable" &&
          ++durableSteps === 2) {
          controller.abort(new Error("cancel after first durable directory bind"));
        }
      }
    }
  );
  const [first, second] = plan.parentMaterialization.missingDirectories;
  assert.equal(receipt.outcome, "cancelled", JSON.stringify(receipt));
  assert.equal(receipt.directoryMaterialization.state, "created-and-retained");
  assert.deepEqual(receipt.directoryMaterialization.observedCreatedDirectories, [
    first
  ]);
  assert.equal((await lstat(join(root, first))).isDirectory(), true);
  await assert.rejects(
    lstat(join(root, second)),
    { code: "ENOENT" }
  );
  assert.equal((await inspectDocumentTransactionV2(root)).state, "idle");
});

qualified("post-link parent replacement yields preserved-unknown recovery evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-v2-link-parent-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtures, root, { recursive: true });
  await upgradeProfileV2(root);
  await rm(join(root, "packages/example/src/features/create-widget"), {
    recursive: true
  });
  const { cases, profilePath } = JSON.parse(
    await readFile(join(root, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "feature");
  const plan = await planDocumentationDocument({
    consumerRoot: root,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
  });
  const parent = join(root, plan.parentMaterialization.finalParent);
  const originalParent = `${parent}.original`;
  let replaced = false;
  const receipt = await applyNodeDocumentationPlanPrivately(
    { consumerRoot: root, plan },
    {
      async faultInjector(point) {
        if (point.phase === "after-hard-link" && !replaced) {
          await rename(parent, originalParent);
          await mkdir(parent);
          replaced = true;
        }
      }
    }
  );
  assert.equal(replaced, true);
  assert.equal(receipt.outcome, "recovery-required", JSON.stringify(receipt));
  assert.equal(receipt.commit.publication, "unknown");
  assert.equal(receipt.commit.recoverability, "preserved-for-recovery");
  assert.equal(receipt.directoryMaterialization.state, "preserved-unknown");
  assert.deepEqual(receipt.directoryMaterialization.observedCreatedDirectories, [
    plan.parentMaterialization.finalParent
  ]);
  assert.deepEqual(
    await readFile(join(originalParent, plan.destination.split("/").at(-1))),
    Buffer.from(plan.output.contentBase64, "base64")
  );
  await lstat(join(root, ".agent-teams-local", "scaffolding-transaction.json"));
  assert.equal((await inspectDocumentTransactionV2(root)).state, "recoverable");
});

for (const mutation of ["deleted", "replaced"]) {
  qualified(`unsafe ${mutation} bound directory preserves journal and unknown evidence`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `foundation-document-v2-${mutation}-`));
    t.after(() => rm(root, { force: true, recursive: true }));
    await cp(fixtures, root, { recursive: true });
    await upgradeProfileV2(root);
    await rm(join(root, "packages/example/src/features"), { recursive: true });
    const { cases, profilePath } = JSON.parse(
      await readFile(join(root, "cases.json"), "utf8")
    );
    const vector = cases.find(({ name }) => name === "feature");
    const plan = await planDocumentationDocument({
      consumerRoot: root,
      profilePath,
      intent: vector.intent,
      parentPolicy: "create-missing-real-directories"
    });
    const first = join(root, plan.parentMaterialization.missingDirectories[0]);
    let durableSteps = 0;
    const receipt = await applyNodeDocumentationPlanPrivately(
      { consumerRoot: root, plan },
      {
        async faultInjector(point) {
          if (point.phase !== "after-materializing-journal-durable" ||
            ++durableSteps !== 2) {
            return;
          }
          await rm(first, { recursive: true });
          if (mutation === "replaced") {
            await mkdir(first);
          }
          throw new Error(`${mutation}-bound-directory`);
        }
      }
    );
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.equal(receipt.directoryMaterialization.state, "preserved-unknown");
    assert.deepEqual(receipt.directoryMaterialization.observedCreatedDirectories, [
      plan.parentMaterialization.missingDirectories[0]
    ]);
    assert.equal((await inspectDocumentTransactionV2(root)).state, "recoverable");
  });
}

qualified("nonempty bound directory is retained without rollback deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-v2-nonempty-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtures, root, { recursive: true });
  await upgradeProfileV2(root);
  await rm(join(root, "packages/example/src/features"), { recursive: true });
  const { cases, profilePath } = JSON.parse(
    await readFile(join(root, "cases.json"), "utf8")
  );
  const vector = cases.find(({ name }) => name === "feature");
  const plan = await planDocumentationDocument({
    consumerRoot: root,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
  });
  const first = join(root, plan.parentMaterialization.missingDirectories[0]);
  let durableSteps = 0;
  const receipt = await applyNodeDocumentationPlanPrivately(
    { consumerRoot: root, plan },
    {
      async faultInjector(point) {
        if (point.phase === "after-materializing-journal-durable" &&
          ++durableSteps === 2) {
          await writeFile(join(first, "user-content.txt"), "retain me\n");
          throw new Error("nonempty-bound-directory");
        }
      }
    }
  );
  assert.equal(receipt.outcome, "failed-before-publication");
  assert.equal(receipt.directoryMaterialization.state, "created-and-retained");
  assert.equal(await readFile(join(first, "user-content.txt"), "utf8"), "retain me\n");
  assert.equal((await inspectDocumentTransactionV2(root)).state, "idle");
});
