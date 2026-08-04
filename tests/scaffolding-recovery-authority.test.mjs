import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  assertScaffoldPlanDigest,
  planScaffoldFromFile,
  recoverFilesystemScaffold
} from "../packages/engineering-foundation/dist/scaffolding/internal-rendering-regression-api.js";
import {
  sha256Bytes,
  sha256Json
} from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root) {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: "intents/create-fixture.yaml"
  });
}

function withRecomputedPlanDigest(planValue) {
  const { planDigest: _ignored, ...body } = planValue;
  return { ...body, planDigest: sha256Json(body) };
}

async function writePreparedJournal(root, scaffoldPlan) {
  const journalPath = join(
    root,
    ".agent-teams-local",
    "scaffolding-transaction.json"
  );
  const source = `${JSON.stringify(
    { schemaVersion: 1, state: "PREPARED", plan: scaffoldPlan },
    null,
    2
  )}\n`;
  await mkdir(dirname(journalPath), { recursive: true });
  await writeFile(journalPath, source);
  return { journalPath, source };
}

test("internal renderer replaces a stale journal temporary before applying", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const temporary = join(
      root,
      ".agent-teams-local",
      "scaffolding-transaction.json.tmp"
    );
    await mkdir(dirname(temporary), { recursive: true });
    await writeFile(temporary, "stale v1 temporary\n", "utf8");

    const receipt = await applyFilesystemScaffold(root, scaffoldPlan);

    assert.equal(receipt.outcome, "applied");
    await assert.rejects(readFile(temporary, "utf8"), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a prepared journal that matches current consumer authority", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const firstPath = join(root, ...first.path.split("/"));
    await mkdir(dirname(firstPath), { recursive: true });
    await writeFile(firstPath, Buffer.from(first.after.contentBase64, "base64"));
    const { journalPath } = await writePreparedJournal(root, scaffoldPlan);

    const receipt = await recoverFilesystemScaffold(root);
    assert.equal(receipt?.outcome, "failed-recovered");
    for (const operation of scaffoldPlan.operations) {
      assert.equal(
        (await readFile(join(root, ...operation.path.split("/")))).byteLength,
        operation.after.size
      );
    }
    await assert.rejects(readFile(journalPath, "utf8"), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a self-consistent forged prepared journal before output publication", async () => {
  const root = await createConsumer();
  try {
    const forgedPlan = structuredClone(await plan(root));
    const operation = forgedPlan.operations[0];
    assert.ok(operation);
    const forgedBytes = Buffer.from("export const forged = true;\n");
    operation.after = {
      ...operation.after,
      contentBase64: forgedBytes.toString("base64"),
      digest: sha256Bytes(forgedBytes),
      size: forgedBytes.byteLength
    };
    const selfConsistentPlan = withRecomputedPlanDigest(forgedPlan);
    assert.doesNotThrow(() => assertScaffoldPlanDigest(selfConsistentPlan));
    const { journalPath, source } = await writePreparedJournal(
      root,
      selfConsistentPlan
    );
    const outputPath = join(root, ...operation.path.split("/"));

    for (const finishPreparedJournal of [
      () => recoverFilesystemScaffold(root),
      () => applyFilesystemScaffold(root, selfConsistentPlan)
    ]) {
      await assert.rejects(
        finishPreparedJournal(),
        /not produced by the closed compiler/u
      );
      assert.equal(await readFile(journalPath, "utf8"), source);
      await assert.rejects(readFile(outputPath), /ENOENT/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
