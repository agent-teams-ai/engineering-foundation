import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compatibilityDigest,
  projectScaffoldPlanCompatibility,
  projectScaffoldReceiptCompatibility,
  settleScaffoldingOperations,
} from "../scripts/published-scaffolding-compatibility-e2e.mjs";

test("failed compatibility operations drain a peer's writes before temporary cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-scaffolding-drain-TEST-"));
  const peer = Promise.withResolvers();
  const failure = new Error("current operation failed");
  let settled = false;
  try {
    const outcome = settleScaffoldingOperations([
      Promise.reject(failure),
      peer.promise.then(() => writeFile(join(root, "peer-result"), "complete")),
    ]).catch((error) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(
      settled,
      false,
      "the failed operation cannot release its root while its peer writes",
    );
    peer.resolve();
    assert.equal(await outcome, failure);
    assert.equal(await readFile(join(root, "peer-result"), "utf8"), "complete");
  } finally {
    peer.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility preserves both concurrent failures after draining", async () => {
  const failures = [new Error("current failed"), new Error("historical failed")];
  const operations = [];
  for (const failure of failures) {
    operations.push(Promise.reject(failure));
  }
  await assert.rejects(settleScaffoldingOperations(operations), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    return true;
  });
});

test("published compatibility ignores only release identity fields", () => {
  const publishedPlanBody = {
    schemaVersion: 1,
    compiler: { id: "@agent-teams/engineering-foundation", version: "0.12.0" },
    operations: [{ id: "write:fixture", path: "fixture.md" }],
  };
  const publishedPlan = {
    ...publishedPlanBody,
    planDigest: compatibilityDigest(publishedPlanBody),
  };
  const candidatePlanBody = structuredClone(publishedPlanBody);
  candidatePlanBody.compiler.version = "0.13.0";
  const candidatePlan = {
    ...candidatePlanBody,
    planDigest: compatibilityDigest(candidatePlanBody),
  };
  const projectedPublishedPlan = projectScaffoldPlanCompatibility(publishedPlan, "0.12.0");
  const projectedCandidatePlan = projectScaffoldPlanCompatibility(candidatePlan, "0.13.0");
  assert.deepEqual(projectedCandidatePlan, projectedPublishedPlan);

  const changedPlanBody = structuredClone(candidatePlanBody);
  changedPlanBody.operations[0].path = "changed.md";
  const changedPlan = {
    ...changedPlanBody,
    planDigest: compatibilityDigest(changedPlanBody),
  };
  assert.notDeepEqual(
    projectScaffoldPlanCompatibility(changedPlan, "0.13.0"),
    projectedPublishedPlan,
  );
  assert.throws(
    () => projectScaffoldPlanCompatibility(candidatePlan, "0.14.0"),
    /compiler version/u,
  );
  assert.throws(
    () =>
      projectScaffoldPlanCompatibility(
        { ...candidatePlan, planDigest: "sha256:tampered" },
        "0.13.0",
      ),
    /digest binding/u,
  );
  const extendedCompilerBody = structuredClone(candidatePlanBody);
  extendedCompilerBody.compiler.buildIdentity = "sha256:new-compiler-metadata";
  const extendedCompilerPlan = {
    ...extendedCompilerBody,
    planDigest: compatibilityDigest(extendedCompilerBody),
  };
  assert.notDeepEqual(
    projectScaffoldPlanCompatibility(extendedCompilerPlan, "0.13.0"),
    projectedPublishedPlan,
  );

  const publishedReceiptBody = {
    schemaVersion: 1,
    planDigest: publishedPlan.planDigest,
    operations: [{ operationId: "write:fixture", outcome: "applied" }],
  };
  const publishedReceipt = {
    ...publishedReceiptBody,
    receiptDigest: compatibilityDigest(publishedReceiptBody),
  };
  const candidateReceiptBody = {
    ...structuredClone(publishedReceiptBody),
    planDigest: candidatePlan.planDigest,
  };
  const candidateReceipt = {
    ...candidateReceiptBody,
    receiptDigest: compatibilityDigest(candidateReceiptBody),
  };
  assert.deepEqual(
    projectScaffoldReceiptCompatibility(candidateReceipt, {
      originalPlanDigest: candidatePlan.planDigest,
      projectedPlanDigest: projectedCandidatePlan.planDigest,
    }),
    projectScaffoldReceiptCompatibility(publishedReceipt, {
      originalPlanDigest: publishedPlan.planDigest,
      projectedPlanDigest: projectedPublishedPlan.planDigest,
    }),
  );

  const changedReceiptBody = structuredClone(candidateReceiptBody);
  changedReceiptBody.operations[0].outcome = "conflict";
  const changedReceipt = {
    ...changedReceiptBody,
    receiptDigest: compatibilityDigest(changedReceiptBody),
  };
  assert.notDeepEqual(
    projectScaffoldReceiptCompatibility(changedReceipt, {
      originalPlanDigest: candidatePlan.planDigest,
      projectedPlanDigest: projectedCandidatePlan.planDigest,
    }),
    projectScaffoldReceiptCompatibility(publishedReceipt, {
      originalPlanDigest: publishedPlan.planDigest,
      projectedPlanDigest: projectedPublishedPlan.planDigest,
    }),
  );
});
