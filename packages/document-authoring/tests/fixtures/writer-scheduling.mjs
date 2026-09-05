import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

const operation = process.argv[2];
assert.ok(operation === "apply" || operation === "recover");
const root = await mkdtemp(join(tmpdir(), "authoring-writer-scheduling-"));
const events = [];
const controller = new AbortController();
const stopped = new Error("Stop before filesystem coordination.");
const coordinator = {
  async acquire() { throw stopped; }
};

// Only replace factory observation; run the real composition and use cases.
// The two queued callbacks expose a lost or added continuation at this boundary.
mock.module(new URL("../../dist/document-authoring/adapters/node/node-document-transaction-coordinator.js", import.meta.url), {
  exports: {
    createNodeDocumentTransactionCoordinator() {
      events.push("coordinator");
      queueMicrotask(() => {
        controller.abort();
        events.push("abort");
        queueMicrotask(() => events.push("next-microtask"));
      });
      return coordinator;
    }
  }
});

try {
  const writer = await import(process.env.AUTHORING_SCHEDULING_MODULE ??
    new URL("../../dist/document-authoring/adapters/node/node-document-writing.js", import.meta.url).href);
  const operations = {
    get faultInjector() {
      if (!events.includes("runtime")) {
        events.push("runtime");
        assert.equal(controller.signal.aborted, true);
      }
      return () => assert.fail("No transaction should run in this fixture.");
    }
  };
  const request = { consumerRoot: root, signal: controller.signal };
  if (operation === "apply") {
    const { documentPlanDigest } = await import("../../dist/document-authoring/application/policies/document-contract-digests.js");
    const { plan } = JSON.parse(await readFile(new URL(
      "../../../../tests/fixtures/document-authoring-contracts/valid-v1.json", import.meta.url
    ), "utf8"));
    plan.compiler.id = "@agent-teams/document-authoring";
    plan.planDigest = documentPlanDigest(plan);
    const receipt = await writer.applyNodeDocumentationPlan({ ...request, plan }, { assess() { assert.fail("No authority IO before coordination"); } }, operations);
    assert.equal(receipt.outcome, "cancelled");
    assert.equal(receipt.commit.publication, "none");
  } else {
    await assert.rejects(writer.recoverNodeDocumentationTransaction(request, { assess() { assert.fail("No authority IO before coordination"); } }, operations),
      (error) => error === stopped);
  }
  assert.deepEqual(events, ["coordinator", "abort", "runtime", "next-microtask"]);
  assert.deepEqual(await readdir(root), []);
  process.stdout.write(JSON.stringify({ operation, outcome: "passed" }));
} finally {
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
}
