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
import { sha256Json } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { createAuthorityScaffoldReceipt } from "../packages/engineering-foundation/dist/scaffolding/kernel/authority-receipt.js";

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
