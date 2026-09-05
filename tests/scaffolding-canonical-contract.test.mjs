import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertScaffoldPlanDigest,
  assertScaffoldReceiptDigest,
  planScaffoldFromFile
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import {
  canonicalJson,
  sha256Json,
} from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { createAuthorityScaffoldReceipt } from "../packages/engineering-foundation/dist/scaffolding/adapters/inbound/authority-scaffold-receipt.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer"
);

async function canonicalPlan() {
  return planScaffoldFromFile({
    consumerRoot: fixtureRoot,
    intentPath: "intents/create-fixture.yaml"
  });
}

function withReceiptDigest(receipt) {
  const { receiptDigest: _ignored, ...body } = receipt;
  return { ...body, receiptDigest: sha256Json(body) };
}

test("freezes legacy scaffolding v1 canonical edge values", () => {
  const vectors = [
    {
      value: -0,
      canonical: "0",
      digest: "sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    },
    {
      value: "\ud800",
      canonical: '"\\ud800"',
      digest: "sha256:8c0c59dd0d275aadcd462a5fe12eb352cbdfeaf961eae4f85a4660521df7d2f5",
    },
  ];

  for (const vector of vectors) {
    assert.equal(canonicalJson(vector.value), vector.canonical);
    assert.equal(sha256Json(vector.value), vector.digest);
  }
});

test("canonical public assertion rejects unsupported protocol discriminators", async () => {
  const unsupportedDiscriminators = {
    ...(await canonicalPlan()),
    schemaVersion: 2,
    protocolVersion: 2
  };

  assert.throws(
    () => assertScaffoldPlanDigest(unsupportedDiscriminators),
    /canonical protocol/u
  );
});

test("embedded and standalone authority schemas require canonical source order", async () => {
  const plan = structuredClone(await canonicalPlan());
  [plan.authorityEvidence.sources[1], plan.authorityEvidence.sources[2]] = [
    plan.authorityEvidence.sources[2],
    plan.authorityEvidence.sources[1]
  ];

  await assert.rejects(
    assertSchema(
      "scaffold-authority-evidence/v1",
      plan.authorityEvidence,
      "authority-source-order"
    )
  );
  await assert.rejects(
    assertSchema("scaffold-plan/v1", plan, "embedded-authority-source-order")
  );
});

test("applied Receipt factory and validator agree on canonical operation order", async () => {
  const plan = await canonicalPlan();
  assert.ok(plan.operations.length > 1);
  const receipt = createAuthorityScaffoldReceipt({
    plan,
    outcome: "applied",
    commitState: "committed",
    operations: plan.operations.map((operation, index) => ({
      operationId: operation.id,
      path: operation.path,
      outcome: index === 1 ? "applied" : "already-satisfied",
      resultDigest: operation.after.digest
    }))
  });
  assert.equal(receipt.operations[0].outcome, "applied");

  const forged = structuredClone(receipt);
  [forged.operations[0], forged.operations[1]] = [
    forged.operations[1],
    forged.operations[0]
  ];
  const { receiptDigest: _ignored, ...body } = forged;
  forged.receiptDigest = sha256Json(body);
  await assert.rejects(
    assertSchema("scaffold-receipt/v1", forged, "canonical-operation-order")
  );
  assert.throws(
    () => assertScaffoldReceiptDigest(forged, plan),
    /applied evidence first/u
  );
});

test("every canonical Receipt outcome covers every Plan operation", async () => {
  const plan = await canonicalPlan();
  assert.ok(plan.operations.length > 1);
  const cases = [
    {
      outcome: "applied",
      commitState: "committed",
      operationOutcome: (_operation, index) =>
        index === 0 ? "applied" : "already-satisfied"
    },
    {
      outcome: "already-applied",
      commitState: "committed",
      operationOutcome: () => "already-satisfied"
    },
    {
      outcome: "failed-recovered",
      commitState: "recovered",
      operationOutcome: () => "recovered"
    },
    {
      outcome: "recovery-required",
      commitState: "recovery-required",
      operationOutcome: () => "unobserved"
    },
    {
      outcome: "rejected",
      commitState: "rejected",
      operationOutcome: () => "not-applied"
    },
    {
      outcome: "authority-stale",
      commitState: "rolled-back",
      operationOutcome: () => "not-applied"
    }
  ];

  for (const receiptCase of cases) {
    const receipt = createAuthorityScaffoldReceipt({
      plan,
      outcome: receiptCase.outcome,
      commitState: receiptCase.commitState,
      operations: plan.operations.map((operation, index) => {
        const outcome = receiptCase.operationOutcome(operation, index);
        return {
          operationId: operation.id,
          path: operation.path,
          outcome,
          ...(["already-satisfied", "applied", "recovered"].includes(outcome)
            ? { resultDigest: operation.after.digest }
            : {})
        };
      })
    });
    const incomplete = structuredClone(receipt);
    incomplete.operations.pop();
    const forged = withReceiptDigest(incomplete);

    await assertSchema("scaffold-receipt/v1", forged, `missing-${receiptCase.outcome}`);
    assert.throws(
      () => assertScaffoldReceiptDigest(forged, plan),
      /evidence for every Plan operation/u,
      receiptCase.outcome
    );
  }
});

test("rejected canonical Receipts require operation evidence", async () => {
  const plan = await canonicalPlan();
  const rejected = withReceiptDigest({
    schemaVersion: 1,
    protocolVersion: 1,
    planDigest: plan.planDigest,
    adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
    outcome: "rejected",
    commit: { state: "rejected", atomicity: "journaled-recoverable" },
    operations: [],
    diagnostics: []
  });

  await assert.rejects(
    assertSchema("scaffold-receipt/v1", rejected, "empty-rejected-receipt")
  );
  assert.throws(
    () => assertScaffoldReceiptDigest(rejected),
    /requires operation evidence/u
  );
});


test("compiles through an alternate parameter port without changing definition or output digests", async () => {
  const { ScaffoldDefinitionRegistry } = await import("../packages/engineering-foundation/dist/scaffolding/kernel/definition-registry.js");
  const { AjvScaffoldParameterValidation } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/outbound/ajv-parameter-validation.js");
  const { compileScaffoldRendering } = await import("../packages/engineering-foundation/dist/scaffolding/kernel/compiler.js");
  const schema = { type: "object", additionalProperties: false };
  const profile = { id: "test.profile", contractVersion: 1 };
  const recipe = { id: "test.recipe", contractVersion: 1 };
  let compileCount = 0;
  const definitions = [
    { kind: "scaffold-profile", ref: profile, descriptor: {}, parameterSchema: schema,
      allowedRecipeIds: [recipe.id], requiredPolicies: [] },
    { kind: "recipe", ref: recipe, descriptor: {}, parameterSchema: schema,
      allowedProfileIds: [profile.id], allowedTargetRoles: ["testing"], requiredPolicies: [],
      compile: ({ target }) => {
        compileCount += 1;
        return [{ path: `${target.path}/index.ts`, content: "export {};\n", mediaType: "text/typescript", causes: [recipe.id] }];
      } }
  ];
  const calls = [];
  const alternate = new ScaffoldDefinitionRegistry(definitions, {
    validate: ({ definitionKey, schema: observed, parameters }) => {
      assert.equal(observed, schema);
      calls.push(definitionKey);
      if (Object.keys(parameters).length !== 0) { throw new Error("parameters must be empty"); }
    }
  });
  const standard = new ScaffoldDefinitionRegistry(definitions, new AjvScaffoldParameterValidation());
  const input = {
    foundationVersion: "0.21.0",
    intent: { schemaVersion: 1, compositionId: "test", targetRef: "target" },
    composition: { id: "test", scaffoldProfile: { ref: profile }, recipe: { ref: recipe }, targetRoles: ["testing"], policies: [] },
    target: { id: "target", role: "testing", path: "packages/example", packageName: "@example/test" }
  };
  assert.deepEqual(compileScaffoldRendering(input, alternate), compileScaffoldRendering(input, standard));
  assert.deepEqual(calls, ["test.profile@1", "test.recipe@1"]);
  assert.equal(compileCount, 2);
  assert.throws(() => compileScaffoldRendering({ ...input, intent: { ...input.intent, recipeParameters: { unknown: true } } }, alternate), /parameters must be empty/u);
  assert.equal(compileCount, 2, "invalid parameters cannot reach recipe effects");
  assert.throws(() => compileScaffoldRendering({ ...input, intent: { ...input.intent, recipeParameters: { unknown: true } } }, standard), {
    code: "SCAFFOLD_INPUT_INVALID",
    message: "Invalid parameters for test.recipe@1: / must NOT have additional properties"
  });
});

test("parameter adapter cache distinguishes definitions with the same key and different schemas", async () => {
  const { AjvScaffoldParameterValidation } = await import("../packages/engineering-foundation/dist/scaffolding/adapters/outbound/ajv-parameter-validation.js");
  const validator = new AjvScaffoldParameterValidation();
  const first = { type: "object", properties: { first: { type: "boolean" } }, required: ["first"] };
  const second = { type: "object", properties: { second: { type: "boolean" } }, required: ["second"] };
  validator.validate({ definitionKey: "test@1", schema: first, parameters: { first: true } });
  validator.validate({ definitionKey: "test@1", schema: second, parameters: { second: true } });
  assert.throws(() => validator.validate({ definitionKey: "test@1", schema: second, parameters: { first: true } }), /second/u);
});
