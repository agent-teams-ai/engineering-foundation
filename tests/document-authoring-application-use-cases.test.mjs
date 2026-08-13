import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyDocumentPlan } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/apply-document-plan.js";
import { recoverDocumentTransaction } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/recover-document-transaction.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";
import { createDocumentTransactionEnvelope } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";

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
      async inspect() {
        return envelope === undefined
          ? { state: "idle" }
          : { state: "recoverable" };
      }
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
      async stabilizeForReconciliation() {
        events.push("journal:stabilize");
        return envelope === undefined ? undefined : { envelope, identity: journalIdentity };
      },
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
    seedJournal(value) { envelope = value; journalIdentity = identity; },
    setCoordinatorState(value) { coordinatorState = value; },
    setDestination(value) { destination = value; },
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

for (const finalState of ["exact", "conflict"]) {
  test(`cancellation rejects a late external ${finalState} destination after clean evidence removal`, async () => {
    const subject = harness();
    const classify = subject.dependencies.fileState.classifyDestination;
    subject.dependencies.fileState.classifyDestination = async () => {
      if (subject.events.includes("journal:remove")) {
        return finalState === "exact"
          ? { state: "exact", identity }
          : { state: "conflict", reason: "external writer won the race" };
      }
      return classify();
    };
    subject.dependencies.publisher.prepare = async () => {
      const error = new Error("cancelled"); error.name = "AbortError";
      throw error;
    };
    const receipt = await applyDocumentPlan(subject.dependencies, {
      consumerRoot: "/fixture", plan: fixture.plan
    });
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.commit.publication, "none");
    assert.equal(subject.state().envelope, undefined);
    assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
  });
}

test("cancellation reports manual recovery when the final destination cannot be verified", async () => {
  const subject = harness();
  const classify = subject.dependencies.fileState.classifyDestination;
  subject.dependencies.fileState.classifyDestination = async () =>
    subject.events.includes("journal:remove")
      ? { state: "unverifiable", reason: "injected final lstat failure" }
      : classify();
  subject.dependencies.publisher.prepare = async () => {
    const error = new Error("cancelled"); error.name = "AbortError";
    throw error;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "manual-recovery-required");
  assert.equal(receipt.commit.state, "manual-recovery-required");
  assert.equal(
    receipt.diagnostics[0].ruleId,
    "document.transaction.cleanup-unproven"
  );
  assert.equal(subject.state().envelope, undefined);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: true }]);
});

for (const temporaryState of ["conflict", "unverifiable"]) {
  test(`prepublication ${temporaryState} temporary is preserved for manual recovery`, async () => {
    const subject = harness();
    subject.dependencies.publisher.prepare = async ({ plan }) => {
      const prepared = {
        path: documentTemporaryPath(plan.destination, plan.planDigest),
        digest: plan.output.digest,
        identity
      };
      subject.dependencies.fileState.classifyDerivedTemporary = async () => ({
        state: "present", path: prepared.path, identity
      });
      subject.dependencies.fileState.classifyTemporary = async () => ({
        state: temporaryState,
        reason: `injected ${temporaryState} temporary`
      });
      throw new Error("prepare failed after leaving temporary evidence");
    };
    const receipt = await applyDocumentPlan(subject.dependencies, {
      consumerRoot: "/fixture", plan: fixture.plan
    });
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.equal(receipt.commit.recoverability, "preserved-for-recovery");
    assert.equal(
      receipt.diagnostics[0].ruleId,
      "document.transaction.cleanup-unproven"
    );
    assert.deepEqual(subject.releases, [{ retainTransactionBarrier: true }]);
  });
}

test("pre-aborted apply validates Plan then returns cancelled without lock or filesystem I/O", async () => {
  const subject = harness();
  const controller = new AbortController();
  controller.abort(new Error("cancel before apply"));
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan, signal: controller.signal
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.deepEqual(subject.events, ["validate"]);
  assert.deepEqual(subject.releases, []);
});

test("abort swallowed by authority adapter is rechecked and reported as cancelled", async () => {
  const subject = harness();
  const controller = new AbortController();
  subject.dependencies.authority.assess = async () => {
    controller.abort(new Error("cancel during authority"));
    return { state: "unverifiable", reason: "adapter masked cancellation" };
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan, signal: controller.signal
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(subject.events.includes("journal:create"), false);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
});

test("abort after durable PREPARED removes journal before reporting cancelled", async () => {
  const subject = harness();
  const controller = new AbortController();
  const originalCreate = subject.dependencies.journal.create;
  subject.dependencies.journal.create = async (envelope) => {
    const result = await originalCreate(envelope);
    controller.abort(new Error("cancel after PREPARED"));
    return result;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan, signal: controller.signal
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(subject.state().envelope, undefined);
  assert.equal(subject.events.includes("prepare"), false);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: false }]);
});

test("abort after temp preparation but before PUBLISHING cleans temp and journal", async () => {
  const subject = harness();
  const controller = new AbortController();
  const originalPrepare = subject.dependencies.publisher.prepare;
  subject.dependencies.publisher.prepare = async (request) => {
    const result = await originalPrepare(request);
    controller.abort(new Error("cancel before PUBLISHING"));
    return result;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan, signal: controller.signal
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(subject.state().temporary, undefined);
  assert.equal(subject.state().envelope, undefined);
  assert.equal(subject.events.includes("publish"), false);
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

test("journal create transition residue prevents a false terminal failure Receipt", async () => {
  const subject = harness();
  subject.dependencies.journal.create = async () => {
    throw new Error("create failed with hidden transition residue");
  };
  subject.dependencies.journal.read = async () => {
    throw new Error("incomplete journal transition evidence");
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "manual-recovery-required");
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: true }]);
});

test("journal create that commits then throws is reconciled and continued", async () => {
  const subject = harness();
  const create = subject.dependencies.journal.create;
  subject.dependencies.journal.create = async (envelope) => {
    await create(envelope);
    throw new Error("lost create acknowledgement");
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "applied");
  assert.equal(subject.events.filter((event) => event === "journal:create").length, 1);
  assert.equal(subject.state().envelope, undefined);
});

test("PUBLISHING replacement that commits then throws preserves temp and continues", async () => {
  const subject = harness();
  const replace = subject.dependencies.journal.replace;
  let thrown = false;
  subject.dependencies.journal.replace = async (request) => {
    const result = await replace(request);
    if (request.envelope.state === "PUBLISHING" && !thrown) {
      thrown = true;
      throw new Error("lost PUBLISHING acknowledgement");
    }
    return result;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "applied");
  assert.equal(subject.events.includes("publish"), true);
  assert.equal(subject.state().temporary, undefined);
});

test("PUBLISHED replacement that commits then throws is reconciled and finalized", async () => {
  const subject = harness();
  const replace = subject.dependencies.journal.replace;
  subject.dependencies.journal.replace = async (request) => {
    const result = await replace(request);
    if (request.envelope.state === "PUBLISHED") {
      throw new Error("lost PUBLISHED acknowledgement");
    }
    return result;
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "applied");
  assert.equal(subject.state().envelope, undefined);
});

test("final journal removal that commits then throws is reconciled as success", async () => {
  const subject = harness();
  const remove = subject.dependencies.journal.remove;
  subject.dependencies.journal.remove = async (expected) => {
    await remove(expected);
    throw new Error("lost removal acknowledgement");
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "applied");
  assert.equal(subject.state().envelope, undefined);
});

test("unverifiable journal replacement returns manual receipt and preserves temp", async () => {
  const subject = harness();
  let first = true;
  const read = subject.dependencies.journal.read;
  subject.dependencies.journal.replace = async () => {
    throw new Error("replace acknowledgement lost");
  };
  subject.dependencies.journal.read = async () => {
    if (first) {
      first = false;
      return read();
    }
    throw new Error("transition residue cannot be classified");
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "manual-recovery-required");
  assert.notEqual(subject.state().temporary, undefined);
  assert.notEqual(subject.state().envelope, undefined);
  assert.deepEqual(subject.releases, [{ retainTransactionBarrier: true }]);
});

test("same-identity already-satisfied publication completes instead of going manual", async () => {
  const subject = harness();
  subject.dependencies.publisher.publishPrepared = async () => {
    subject.setDestination("exact");
    return { outcome: "already-satisfied", publicationIdentity: identity };
  };
  subject.dependencies.publisher.completePublication = async () => ({
    publicationIdentity: identity
  });
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "applied");
});

test("different-identity already-satisfied publication requires manual recovery", async () => {
  const subject = harness();
  subject.dependencies.publisher.publishPrepared = async () => {
    subject.setDestination("exact");
    return {
      outcome: "already-satisfied",
      publicationIdentity: { ...identity, ino: "999" }
    };
  };
  const receipt = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(receipt.outcome, "manual-recovery-required");
  assert.notEqual(subject.state().temporary, undefined);
});

test("recovery preserves primary failure when lease release also fails", async () => {
  const subject = harness();
  subject.setCoordinatorState("idle");
  subject.dependencies.coordinator.acquire = async () => ({
    status: { state: "idle" },
    async release() { throw new Error("release failed"); }
  });
  await assert.rejects(
    recoverDocumentTransaction(subject.dependencies, { consumerRoot: "/fixture" }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /requires a coordinator-qualified/u);
      assert.match(error.errors[1].message, /release failed/u);
      assert.equal(error.cause, error.errors[0]);
      return true;
    }
  );
});

test("apply preserves journal failure when lease release also fails", async () => {
  const subject = harness();
  subject.dependencies.journal.create = async () => {
    throw new Error("create failed");
  };
  subject.dependencies.journal.stabilizeForReconciliation = async () => {
    throw new Error("transition unverifiable");
  };
  subject.dependencies.coordinator.acquire = async () => ({
    status: { state: "idle" },
    async release() { throw new Error("release failed"); }
  });
  await assert.rejects(
    applyDocumentPlan(subject.dependencies, {
      consumerRoot: "/fixture", plan: fixture.plan
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      const primary = error.errors[0];
      assert.ok(primary instanceof AggregateError);
      assert.match(primary.errors[0].message, /create failed/u);
      assert.match(primary.errors[1].message, /transition unverifiable/u);
      assert.match(error.errors[1].message, /release failed/u);
      assert.equal(error.cause, primary);
      return true;
    }
  );
});

test("apply preserves body, cleanup, and lease release failures", async () => {
  const subject = harness();
  subject.dependencies.publisher.prepare = async () => {
    throw new Error("body failed");
  };
  subject.dependencies.journal.remove = async () => {
    throw new Error("cleanup journal removal failed");
  };
  subject.dependencies.coordinator.acquire = async () => ({
    status: { state: "idle" },
    async release() { throw new Error("release failed"); }
  });
  await assert.rejects(
    applyDocumentPlan(subject.dependencies, {
      consumerRoot: "/fixture", plan: fixture.plan
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      const applyAndCleanup = error.errors[0];
      assert.ok(applyAndCleanup instanceof AggregateError);
      assert.match(applyAndCleanup.errors[0].message, /body failed/u);
      assert.match(
        applyAndCleanup.errors[1].message,
        /Journal removal reported failure/u
      );
      assert.match(
        applyAndCleanup.errors[1].cause.message,
        /cleanup journal removal failed/u
      );
      assert.match(error.errors[1].message, /release failed/u);
      assert.equal(error.cause, applyAndCleanup);
      return true;
    }
  );
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

async function interruptedPublishingHarness() {
  const subject = harness();
  subject.dependencies.publisher.publishPrepared = async () => {
    throw new Error("crash before link");
  };
  const interrupted = await applyDocumentPlan(subject.dependencies, {
    consumerRoot: "/fixture", plan: fixture.plan
  });
  assert.equal(interrupted.outcome, "recovery-required");
  assert.equal(subject.state().envelope.state, "PUBLISHING");
  subject.setCoordinatorState("recoverable");
  return subject;
}

test("recovery preserves abort swallowed during filesystem observation", async () => {
  const subject = await interruptedPublishingHarness();
  const authorityCount = subject.events.filter((event) => event === "authority").length;
  const controller = new AbortController();
  const abort = new Error("abort during recovery observation");
  abort.name = "AbortError";
  subject.dependencies.fileState.classifyDestination = async () => {
    controller.abort(abort);
    return { state: "absent" };
  };
  await assert.rejects(
    recoverDocumentTransaction(subject.dependencies, {
      consumerRoot: "/fixture", signal: controller.signal
    }),
    (error) => error === abort
  );
  assert.equal(subject.events.includes("recovery:publish"), false);
  assert.equal(
    subject.events.filter((event) => event === "authority").length,
    authorityCount
  );
  assert.equal(subject.state().envelope.state, "PUBLISHING");
  assert.notEqual(subject.state().temporary, undefined);
  assert.deepEqual(subject.releases.at(-1), { retainTransactionBarrier: true });
});

test("recovery preserves abort swallowed during authority replay", async () => {
  const subject = await interruptedPublishingHarness();
  const controller = new AbortController();
  const abort = new Error("abort during recovery authority");
  abort.name = "AbortError";
  subject.dependencies.authority.assess = async ({ plan }) => {
    controller.abort(abort);
    return { state: "current", plan };
  };
  await assert.rejects(
    recoverDocumentTransaction(subject.dependencies, {
      consumerRoot: "/fixture", signal: controller.signal
    }),
    (error) => error === abort
  );
  assert.equal(subject.events.includes("recovery:publish"), false);
  assert.equal(subject.state().envelope.state, "PUBLISHING");
  assert.notEqual(subject.state().temporary, undefined);
  assert.deepEqual(subject.releases.at(-1), { retainTransactionBarrier: true });
});

async function publishedEnvelope(publicationIdentity = identity) {
  return createDocumentTransactionEnvelope({
    adapterContractVersion: 1,
    foundation: {
      buildIdentity: fixture.plan.compiler.buildIdentity,
      version: fixture.plan.compiler.version
    },
    journal: {
      destination: { path: fixture.plan.destination, state: "published" },
      plan: fixture.plan,
      publicationIdentity,
      schemaVersion: 2
    },
    operationKind: "document-authoring",
    payloadKind: "document-authoring-journal/v2",
    recoveryHandler: { contractVersion: 2, id: "foundation.document-authoring" },
    schemaVersion: 3,
    state: "PUBLISHED"
  });
}

for (const scenario of [
  { name: "missing", destination: "absent" },
  { name: "changed bytes", destination: "conflict" },
  { name: "identity drift", destination: "exact", drift: true }
]) {
  test(`PUBLISHED ${scenario.name} is manual before authority replay`, async () => {
    const subject = harness({ destination: scenario.destination });
    subject.setCoordinatorState("recoverable");
    subject.seedJournal(await publishedEnvelope());
    if (scenario.drift === true) {
      subject.dependencies.fileState.classifyDestination = async () => ({
        state: "exact",
        identity: { ...identity, ino: "999" }
      });
    }
    const receipt = await recoverDocumentTransaction(subject.dependencies, {
      consumerRoot: "/fixture"
    });
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.equal(subject.events.includes("authority"), false);
    assert.notEqual(subject.state().envelope, undefined);
    assert.deepEqual(subject.releases, [{ retainTransactionBarrier: true }]);
  });
}
