import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { NodeDocumentContractValidator } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-contract-validator.js";
import { DocumentPlanningError } from "../packages/document-authoring/dist/document-authoring/application/model/document-planning-error.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function validPlan() {
  return structuredClone(fixture.plan);
}

function rejectsPlan(validator, value) {
  return assert.rejects(
    validator.validatePlan(value),
    (error) =>
      error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_OUTPUT_INVALID" &&
      error.message.length < 1200,
  );
}

test("Plan validation snapshots and deeply freezes before its async boundary", async () => {
  const validator = new NodeDocumentContractValidator();
  const callerPlan = validPlan();
  const validation = validator.validatePlan(callerPlan);
  callerPlan.destination = "docs/decisions/caller-mutation.md";
  callerPlan.output.contentBase64 = Buffer.from("mutated\n").toString("base64");

  const snapshot = await validation;
  assert.notEqual(snapshot, callerPlan);
  assert.equal(snapshot.destination, fixture.plan.destination);
  assert.equal(snapshot.output.contentBase64, fixture.plan.output.contentBase64);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.intent), true);
  assert.equal(Object.isFrozen(snapshot.referencedDocuments), true);
  assert.equal(Object.isFrozen(snapshot.output), true);
});

test("Plan validation rejects accessors, Proxy objects, symbols, and hidden data inertly", async () => {
  const validator = new NodeDocumentContractValidator();
  let executions = 0;
  const accessorPlan = validPlan();
  Object.defineProperty(accessorPlan.output, "contentBase64", {
    enumerable: true,
    get() {
      executions += 1;
      throw new Error("must not execute");
    },
  });
  await rejectsPlan(validator, accessorPlan);

  const proxyPlan = validPlan();
  proxyPlan.output = new Proxy(proxyPlan.output, {
    getOwnPropertyDescriptor() {
      executions += 1;
      throw new Error("must not execute");
    },
    getPrototypeOf() {
      executions += 1;
      throw new Error("must not execute");
    },
    ownKeys() {
      executions += 1;
      throw new Error("must not execute");
    },
  });
  await rejectsPlan(validator, proxyPlan);
  assert.equal(executions, 0);

  const symbolPlan = validPlan();
  symbolPlan.intent[Symbol("hidden")] = true;
  await rejectsPlan(validator, symbolPlan);

  const hiddenPlan = validPlan();
  Object.defineProperty(hiddenPlan.intent, "hidden", {
    enumerable: false,
    value: true,
  });
  await rejectsPlan(validator, hiddenPlan);

  const extraArrayPropertyPlan = validPlan();
  extraArrayPropertyPlan.referencedDocuments.extra = true;
  await rejectsPlan(validator, extraArrayPropertyPlan);
});

test("Plan validation rejects deep, cyclic, and shared-container amplification", async () => {
  const validator = new NodeDocumentContractValidator();
  const cyclicPlan = validPlan();
  cyclicPlan.intent.loop = cyclicPlan;
  await rejectsPlan(validator, cyclicPlan);

  const sharedPlan = validPlan();
  const shared = { value: "same-container" };
  sharedPlan.intent.additionalMetadata = { first: shared, second: shared };
  await rejectsPlan(validator, sharedPlan);

  const deepPlan = validPlan();
  let cursor = deepPlan.intent;
  for (let depth = 0; depth < 10_000; depth += 1) {
    cursor.additionalMetadata = {};
    cursor = cursor.additionalMetadata;
  }
  await rejectsPlan(validator, deepPlan);
});

test("Plan validation verifies output bytes, digest, size, mode, and Plan digest", async () => {
  const validator = new NodeDocumentContractValidator();
  for (const mutate of [
    (plan) => {
      plan.output.contentBase64 = Buffer.from("different\n").toString("base64");
    },
    (plan) => {
      plan.output.size += 1;
    },
    (plan) => {
      plan.output.digest = `sha256:${"0".repeat(64)}`;
    },
    (plan) => {
      plan.output.mode = "0600";
    },
    (plan) => {
      plan.output.contentBase64 = "A".repeat(1_398_108);
    },
    (plan) => {
      plan.planDigest = `sha256:${"0".repeat(64)}`;
    },
  ]) {
    const plan = validPlan();
    mutate(plan);
    await rejectsPlan(validator, plan);
  }
});
