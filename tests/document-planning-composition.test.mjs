import { createNodeDocumentAuthority } from "../packages/document-authoring/dist/document-authoring/module.js";
import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../packages/document-authoring/dist/documentation-observation/module.js";
import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {
  planDocumentationDocument,
} from "../packages/document-authoring/dist/index.js";
import {
  planNodeDocumentationDocument as planWithObservation,
} from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-planning.js";

import {
  DocumentPlanningError,
} from "../packages/document-authoring/dist/document-authoring/application/model/document-planning-error.js";

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

test("the Node document authority assessment propagates cancellation", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    createNodeDocumentAuthority(observation).assess({
      consumerRoot: fixtures,
      plan: {},
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.problem?.code, "EXECUTION_CANCELLED");
      return true;
    },
  );
});

test("the Node document authority replay propagates cancellation", async () => {
  const {cases, profilePath} = JSON.parse(
    await readFile(join(fixtures, "cases.json"), "utf8"),
  );
  const vector = cases.find(({name}) => name === "adr");
  assert.ok(vector);

  await withFixture(async (consumerRoot) => {
    const plan = await planNodeDocumentationDocument({
      consumerRoot,
      profilePath,
      intent: vector.intent,
    });
    const controller = new AbortController();
    const assessment = createNodeDocumentAuthority(observation).assess({
      consumerRoot,
      plan,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(assessment, (error) => {
      assert.equal(error.problem?.code, "EXECUTION_CANCELLED");
      return true;
    });
  });
});

function planNodeDocumentationDocument(request) { return planWithObservation(request, observation); }

const observation = { repository: new FilesystemMarkdownRepository(), readFile: readContainedRegularFile, syntax: readMarkdownSyntax };

test("authority replay accepts independent planner and validator ports without Node IO", async () => {
  const { RecompileDocumentAuthority } = await import("../packages/document-authoring/dist/document-authoring/application/use-cases/document-authority-recompiler.js");
  const { documentPlanDigest } = await import("../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js");
  const { plan } = JSON.parse(await readFile(new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url), "utf8"));
  const calls = [];
  const contracts = { async validatePlan(value) { calls.push("validate"); assert.equal(value, plan); return plan; } };
  const replay = new RecompileDocumentAuthority({ contracts, async plan(input) {
    calls.push(input);
    return structuredClone(plan);
  } });
  assert.deepEqual(await replay.assess({ consumerRoot: "/unmounted-fake", plan }), { state: "current", plan });
  assert.deepEqual(calls, ["validate", { consumerRoot: "/unmounted-fake", profilePath: plan.authority.profile.path, intent: plan.intent }]);
  const changed = structuredClone(plan);
  changed.compiler.buildIdentity = `sha256:${"f".repeat(64)}`;
  changed.planDigest = documentPlanDigest(changed);
  assert.equal((await new RecompileDocumentAuthority({ contracts, async plan() { return changed; } })
    .assess({ consumerRoot: "/unmounted-fake", plan })).state, "stale");
  for (const [failure, expected] of [
    [new DocumentPlanningError("DOCUMENT_PLANNING_INPUT_INVALID", "Authority no longer admits the input"), "stale"],
    [new DocumentPlanningError("DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE", "Authority read failed"), "unverifiable"],
    [new Error("Provider disconnected"), "unverifiable"]
  ]) {
    const result = await new RecompileDocumentAuthority({ contracts, async plan() { throw failure; } })
      .assess({ consumerRoot: "/unmounted-fake", plan });
    assert.equal(result.state, expected);
    assert.ok(result.reason.endsWith(failure.message));
  }
});
