import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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
const requiresStrictDirectoryDurability = process.platform === "win32"
  ? test.skip
  : test;

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-public-writer-"));
  try {
    await cp(fixtures, root, { recursive: true });
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

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

requiresStrictDirectoryDurability("public writer applies once and returns exact-self on replay", async () => {
  await withFixture(async (consumerRoot) => {
    const plan = await adrPlan(consumerRoot);
    const applied = await applyDocumentationPlan({ consumerRoot, plan });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.destination, plan.destination);
    assert.equal(applied.resultDigest, plan.output.digest);

    const replay = await applyDocumentationPlan({ consumerRoot, plan });
    assert.equal(replay.outcome, "already-applied");
    assert.equal(replay.resultDigest, plan.output.digest);
  });
});

test("public recovery refuses to manufacture a receipt without evidence", async () => {
  await withFixture(async (consumerRoot) => {
    await assert.rejects(
      recoverDocumentationTransaction({ consumerRoot }),
      /requires a coordinator-qualified recoverable transaction/u
    );
  });
});
