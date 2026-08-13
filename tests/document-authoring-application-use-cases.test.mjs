import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyDocumentPlan } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/apply-document-plan.js";
import { recoverDocumentTransaction } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/recover-document-transaction.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";

const fixture = JSON.parse(await readFile(fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url)
), "utf8"));

const identity = Object.freeze({
  adapter: "node-filesystem", birthtimeNs: "3", dev: "1", ino: "2", version: 1
});

function harness(options = {}) {
  let destination = options.destination ?? "absent";
  let envelope;
  let journalIdentity;
  let temporary;
  let releases = [];
  let coordinatorState = "idle";
  const events = [];
  const dependencies = {
    contractValidator: {
      async validatePlan(input) { events.push("validate"); return structuredClone(input); }
    },
    coordinator: {
      async acquire() {
        events.push("acquire");
        return {
          status: { state: coordinatorState },
          async release(value) { releases.push(value); }
        };
      },
      async inspect() { return { state: coordinatorState }; }
    },
    authority: {
      async assess({ plan }) { events.push("authority"); return { state: "current", plan }; }
    },
    fileState: {
      async classifyDestination() {
        events.push(`destination:${destination}`);
        return destination === "exact"
          ? { state: "exact", identity }
          : { state: destination };
      },
      async classifyDerivedTemporary() {
        return temporary === undefined
          ? { state: "absent" }
          : { state: "present", path: temporary.path, identity: temporary.identity };
      },
      async classifyTemporary() {
        return temporary === undefined
          ? { state: "absent" }
          : { state: "owned-exact", temporary };
      }
    },
    journal: {
      async create(value) { envelope = value; journalIdentity = identity; events.push("journal:create"); return identity; },
      async read() { return envelope === undefined ? undefined : { envelope, identity: journalIdentity }; },
      async remove(expected) { assert.deepEqual(expected, journalIdentity); envelope = undefined; journalIdentity = undefined; events.push("journal:remove"); },
      async replace({ envelope: value, expectedIdentity }) {
        assert.deepEqual(expectedIdentity, journalIdentity);
        envelope = value; journalIdentity = { ...identity, ino: String(Number(identity.ino) + 1) };
        events.push(`journal:${value.state}`);
        return journalIdentity;
      }
    },
    publisher: {
      async prepare({ plan }) {
        events.push("prepare");
        temporary = {
          path: documentTemporaryPath(plan.destination, plan.planDigest),
          digest: plan.output.digest,
          identity
        };
        return temporary;
      },
      async publishPrepared() { events.push("publish"); destination = "exact"; return { outcome: "published", publicationIdentity: identity, identityEvidence: "owned-temporary" }; },
      async completePublication() { return { publicationIdentity: identity }; },
      async removeOwnedTemporary() { events.push("temporary:remove"); temporary = undefined; }
    }
  };
  return {
    dependencies, events, releases,
    setCoordinatorState(value) { coordinatorState = value; },
    state: () => ({ destination, envelope, temporary })
  };
}

test("apply validates before coordination and completes PREPARED-PUBLISHING-PUBLISHED", async () => {
  const subject = harness();
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "applied");
  assert.equal(subject.events[0], "validate");
  assert.ok(subject.events.indexOf("journal:create") < subject.events.indexOf("prepare"));
  assert.ok(subject.events.indexOf("journal:PUBLISHING") < subject.events.indexOf("publish"));
  assert.ok(subject.events.indexOf("journal:PUBLISHED") < subject.events.indexOf("journal:remove"));
  assert.equal(subject.state().envelope, undefined);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
});

test("exact preexisting output is journaled and verified without publication", async () => {
  const subject = harness({ destination: "exact" });
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "already-applied");
  assert.equal(subject.events.includes("publish"), false);
  assert.equal(subject.events.filter((event) => event === "authority").length, 3);
  assert.equal(subject.events.filter((event) => event === "destination:exact").length, 3);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
});

test("cancellation before publication reports cancelled only after durable cleanup", async () => {
  const subject = harness();
  subject.dependencies.publisher.prepare = async () => {
    subject.events.push("prepare");
    const error = new Error("cancelled"); error.name = "AbortError";
    throw error;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(subject.state().envelope, undefined);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
});

test("ambiguous publication preserves transaction evidence and masks cancellation", async () => {
  const subject = harness();
  subject.dependencies.publisher.publishPrepared = async () => {
    subject.events.push("publish");
    const error = new Error("caller aborted during link"); error.name = "AbortError";
    throw error;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "recovery-required");
  assert.equal(subject.state().envelope.state, "PUBLISHING");
  assert.notEqual(subject.state().temporary, undefined);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: true }]);
});

test("failed PREPARED to PUBLISHING CAS cleans exact prepublication evidence", async () => {
  const subject = harness();
  subject.dependencies.journal.replace = async ({ envelope }) => {
    assert.equal(envelope.state, "PUBLISHING");
    throw new Error("journal CAS failed");
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "failed-before-publication");
  assert.equal(subject.state().temporary, undefined);
  assert.equal(subject.state().envelope, undefined);
  assert.equal(subject.events.includes("publish"), false);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
});

test("recovery resumes an exact bound PUBLISHING temporary", async () => {
  const subject = harness();
  subject.dependencies.publisher.publishPrepared = async () => {
    throw new Error("crash before link");
  };
  const interrupted = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(interrupted.outcome, "recovery-required");
  subject.setCoordinatorState("recoverable");
  subject.dependencies.publisher.publishPrepared = async () => {
    subject.events.push("recovery:publish");
    return { outcome: "published", publicationIdentity: identity, identityEvidence: "owned-temporary" };
  };
  // In-memory destination classification follows the successful link.
  const originalPublish = subject.dependencies.publisher.publishPrepared;
  subject.dependencies.publisher.publishPrepared = async (request) => {
    const result = await originalPublish(request);
    subject.dependencies.fileState.classifyDestination = async () => ({ state: "exact", identity });
    return result;
  };
  const recovered = await recoverDocumentTransaction(subject.dependencies, {
    consumerRoot: "/fixture"
  });
  assert.equal(recovered.outcome, "applied");
  assert.equal(subject.state().envelope, undefined);
});
