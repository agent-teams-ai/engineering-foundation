import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import {
  assertScaffoldReceiptDigest,
  MemoryScaffoldWorkspace,
  planScaffoldFromFile,
  validateScaffoldReceipt
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { sha256Json } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);

async function scaffoldPlan() {
  return planScaffoldFromFile({
    consumerRoot: fixtureRoot,
    intentPath: "intents/create-fixture.yaml"
  });
}

function withReceiptDigest(receipt) {
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  return { ...body, receiptDigest: sha256Json(body) };
}

function filesystemAdapter() {
  return { id: "foundation.filesystem/v1", contractVersion: 1 };
}

function filesystemCommit(state) {
  return { state, atomicity: "journaled-recoverable" };
}

function memoryCommit(state) {
  return { state, atomicity: "memory-atomic" };
}

async function assertValidReceipt(receipt, plan) {
  await assertSchema("scaffold-receipt/v1", receipt, "scaffold-receipt-contract");
  assert.equal(await validateScaffoldReceipt(receipt, plan), receipt);
  assert.doesNotThrow(() => assertScaffoldReceiptDigest(receipt));
  assert.doesNotThrow(() => assertScaffoldReceiptDigest(receipt, plan));
}

async function assertInvalidReceipt(receipt) {
  await assert.rejects(
    assertSchema("scaffold-receipt/v1", receipt, "scaffold-receipt-contract")
  );
  assert.throws(
    () => assertScaffoldReceiptDigest(receipt),
    (error) =>
      error instanceof Error &&
      error.name === "ScaffoldError" &&
      error.code === "SCAFFOLD_RECEIPT_INVALID"
  );
}

test("accepts every closed scaffold receipt v1 state", async () => {
  const plan = await scaffoldPlan();
  const workspace = new MemoryScaffoldWorkspace();
  const memoryApplied = await workspace.apply(plan);
  const memoryAlreadyApplied = await workspace.apply(plan);
  const rejectedMemory = withReceiptDigest({
    ...memoryApplied,
    outcome: "rejected",
    commit: memoryCommit("rejected"),
    operations: []
  });
  const filesystemApplied = withReceiptDigest({
    ...memoryApplied,
    adapter: filesystemAdapter(),
    commit: filesystemCommit("committed")
  });
  const filesystemAlreadyApplied = withReceiptDigest({
    ...memoryAlreadyApplied,
    adapter: filesystemAdapter(),
    commit: filesystemCommit("committed")
  });
  const rejectedFilesystem = withReceiptDigest({
    ...rejectedMemory,
    adapter: filesystemAdapter(),
    commit: filesystemCommit("rejected")
  });
  const failedRecovered = withReceiptDigest({
    ...filesystemApplied,
    outcome: "failed-recovered",
    commit: filesystemCommit("recovered"),
    operations: filesystemApplied.operations.map((operation) => ({
      ...operation,
      outcome: "recovered"
    }))
  });
  const recoveryRequired = withReceiptDigest({
    ...filesystemApplied,
    outcome: "recovery-required",
    commit: filesystemCommit("recovery-required"),
    operations: filesystemApplied.operations.map(({ operationId, path }) => ({
      operationId,
      path,
      outcome: "conflict"
    }))
  });

  for (const receipt of [
    memoryApplied,
    filesystemApplied,
    memoryAlreadyApplied,
    filesystemAlreadyApplied,
    rejectedMemory,
    rejectedFilesystem,
    failedRecovered,
    recoveryRequired
  ]) {
    await assertValidReceipt(receipt, plan);
  }
});

test("rejects impossible receipt state combinations and empty completed receipts", async () => {
  const plan = await scaffoldPlan();
  const applied = await new MemoryScaffoldWorkspace().apply(plan);
  const failedRecovered = withReceiptDigest({
    ...applied,
    adapter: filesystemAdapter(),
    outcome: "failed-recovered",
    commit: filesystemCommit("recovered"),
    operations: applied.operations.map((operation) => ({
      ...operation,
      outcome: "recovered"
    }))
  });

  for (const receipt of [
    withReceiptDigest({
      ...applied,
      outcome: "rejected",
      commit: memoryCommit("committed"),
      operations: []
    }),
    withReceiptDigest({
      ...applied,
      adapter: filesystemAdapter(),
      commit: memoryCommit("committed")
    }),
    withReceiptDigest({
      ...failedRecovered,
      adapter: { id: "foundation.memory/v1", contractVersion: 1 },
      commit: memoryCommit("recovered")
    }),
    withReceiptDigest({
      ...applied,
      outcome: "already-applied",
      commit: memoryCommit("committed"),
      operations: []
    }),
    withReceiptDigest({ ...applied, operations: [] }),
    withReceiptDigest({ ...failedRecovered, operations: [] })
  ]) {
    await assertInvalidReceipt(receipt);
  }
});

test("rejects unsupported receipt protocol and adapter metadata", async () => {
  const plan = await scaffoldPlan();
  const applied = await new MemoryScaffoldWorkspace().apply(plan);

  for (const receipt of [
    withReceiptDigest({ ...applied, schemaVersion: 2 }),
    withReceiptDigest({ ...applied, protocolVersion: 2 }),
    withReceiptDigest({
      ...applied,
      outcome: "forged-outcome",
      commit: memoryCommit("rejected"),
      operations: []
    }),
    withReceiptDigest({
      ...applied,
      adapter: { id: "foundation.unknown/v1", contractVersion: 1 }
    }),
    withReceiptDigest({
      ...applied,
      adapter: { ...applied.adapter, contractVersion: 2 }
    })
  ]) {
    await assertInvalidReceipt(receipt);
  }
});

test("requires applied operation evidence for an applied receipt", async () => {
  const plan = await scaffoldPlan();
  const applied = await new MemoryScaffoldWorkspace().apply(plan);
  await assertInvalidReceipt(
    withReceiptDigest({
      ...applied,
      operations: applied.operations.map((operation) => ({
        ...operation,
        outcome: "already-satisfied"
      }))
    })
  );
});

test("rejects digest tampering and validates receipt evidence against its Plan", async () => {
  const plan = await scaffoldPlan();
  const applied = await new MemoryScaffoldWorkspace().apply(plan);
  const tamperedDigest = {
    ...applied,
    receiptDigest: `sha256:${"0".repeat(64)}`
  };
  await assertSchema("scaffold-receipt/v1", tamperedDigest, "scaffold-receipt-contract");
  assert.throws(() => assertScaffoldReceiptDigest(tamperedDigest), /digest/u);

  const forgedEvidence = structuredClone(applied);
  const operation = forgedEvidence.operations[0];
  assert.ok(operation);
  operation.path = "forged/generated.ts";
  const selfConsistentReceipt = withReceiptDigest(forgedEvidence);
  await assertSchema(
    "scaffold-receipt/v1",
    selfConsistentReceipt,
    "scaffold-receipt-contract"
  );
  assert.doesNotThrow(() => assertScaffoldReceiptDigest(selfConsistentReceipt));
  assert.throws(
    () => assertScaffoldReceiptDigest(selfConsistentReceipt, plan),
    /Plan evidence/u
  );
});

test("rejects undeclared properties on untrusted receipts", async () => {
  const plan = await scaffoldPlan();
  const applied = await new MemoryScaffoldWorkspace().apply(plan);
  const forgedReceipts = [
    withReceiptDigest({ ...applied, extension: true }),
    withReceiptDigest({
      ...applied,
      adapter: { ...applied.adapter, extension: true }
    }),
    withReceiptDigest({
      ...applied,
      operations: applied.operations.map((operation, index) =>
        index === 0 ? { ...operation, extension: true } : operation
      )
    })
  ];

  for (const receipt of forgedReceipts) {
    await assert.rejects(validateScaffoldReceipt(receipt, plan));
  }
});
