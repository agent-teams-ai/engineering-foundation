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

test("canonical public assertion rejects old protocol discriminators", async () => {
  const legacyDiscriminators = {
    ...(await canonicalPlan()),
    schemaVersion: 1,
    protocolVersion: 1
  };

  assert.throws(
    () => assertScaffoldPlanDigest(legacyDiscriminators),
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
      "scaffold-authority-evidence",
      plan.authorityEvidence,
      "authority-source-order"
    )
  );
  await assert.rejects(
    assertSchema("scaffold-plan", plan, "embedded-authority-source-order")
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
    assertSchema("scaffold-receipt", forged, "canonical-operation-order")
  );
  assert.throws(
    () => assertScaffoldReceiptDigest(forged, plan),
    /applied evidence first/u
  );
});
