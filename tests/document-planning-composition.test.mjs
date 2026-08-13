import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {
  planDocumentationDocument,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import {
  planNodeDocumentationDocument,
} from "../packages/engineering-foundation/dist/document-authoring/composition/node-document-planning.js";
import {
  DocumentPlanningError,
} from "../packages/engineering-foundation/dist/document-authoring/document-planning-error.js";

const fixtures = fileURLToPath(
  new URL("fixtures/document-planning/orchestrator/", import.meta.url),
);

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-composition-"));
  try {
    await cp(fixtures, root, {recursive: true});
    return await callback(root);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}

test("the public planner delegates to the closed Node planning composition", async () => {
  const {cases, profilePath} = JSON.parse(
    await readFile(join(fixtures, "cases.json"), "utf8"),
  );
  const vector = cases.find(({name}) => name === "adr");
  assert.ok(vector);

  await withFixture(async (consumerRoot) => {
    const request = {consumerRoot, profilePath, intent: vector.intent};
    assert.deepEqual(
      await planDocumentationDocument(request),
      await planNodeDocumentationDocument(request),
    );
  });
});

test("the closed Node planning composition preserves public error mapping", async () => {
  await withFixture(async (consumerRoot) => {
    const request = {
      consumerRoot,
      profilePath: "document-authoring.yaml",
      intent: {schemaVersion: 1, type: "unsupported"},
    };

    for (const plan of [planDocumentationDocument, planNodeDocumentationDocument]) {
      await assert.rejects(plan(request), (error) => {
        assert.ok(error instanceof DocumentPlanningError);
        assert.equal(error.code, "DOCUMENT_PLANNING_INPUT_INVALID");
        return true;
      });
    }
  });
});
