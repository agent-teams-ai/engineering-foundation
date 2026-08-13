import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { documentPlanDigest } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";
import { sha256Json } from "../packages/engineering-foundation/dist/canonical-json.js";
import { NodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";

const fixture = JSON.parse(
  await readFile(
    new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
    "utf8",
  ),
);
const buildIdentity = `sha256:${"2".repeat(64)}`;
const version = "0.16.0";
const physicalIdentity = {
  adapter: "node-filesystem",
  version: 1,
  dev: "1",
  ino: "2",
  birthtimeNs: "3",
};

function envelopeFor(state) {
  const envelope = structuredClone(fixture.documentEnvelope);
  envelope.payloadKind = "document-authoring-journal/v2";
  envelope.schemaVersion = 3;
  envelope.recoveryHandler.contractVersion = 2;
  envelope.state = state;
  envelope.foundation = { version, buildIdentity };
  envelope.journal = {
    schemaVersion: 2,
    plan: structuredClone(fixture.plan),
    destination: {
      path: fixture.plan.destination,
      state:
        state === "PREPARED"
          ? "pending"
          : state === "PUBLISHING"
            ? "publishing"
            : "published",
    },
  };
  envelope.journal.plan.compiler = {
    ...envelope.journal.plan.compiler,
    version,
    buildIdentity,
  };
  envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
  if (state === "PUBLISHING") {
    envelope.journal.ownedTemporary = {
      path: documentTemporaryPath(
        envelope.journal.plan.destination,
        envelope.journal.plan.planDigest,
      ),
      digest: envelope.journal.plan.output.digest,
      identity: physicalIdentity,
    };
  }
  if (state === "PUBLISHED") {
    envelope.journal.publicationIdentity = physicalIdentity;
  }
  envelope.payloadDigest = sha256Json(envelope.journal);
  const { envelopeDigest: _ignored, ...body } = envelope;
  envelope.envelopeDigest = sha256Json(body);
  return envelope;
}

async function createRoot() {
  return mkdtemp(join(tmpdir(), "document-coordination-v2-"));
}

function slotPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function writeEnvelope(root, envelope) {
  await mkdir(dirname(slotPath(root)), { recursive: true });
  await writeFile(slotPath(root), `${JSON.stringify(envelope)}\n`, "utf8");
}

test("recognizes every strict document journal v2 lifecycle as recoverable only by its exact build", async () => {
  for (const state of ["PREPARED", "PUBLISHING", "PUBLISHED"]) {
    const root = await createRoot();
    try {
      await writeEnvelope(root, envelopeFor(state));
      const status = await new NodeFoundationTransactionSlot({
        consumerRoot: root,
        installedVersion: version,
        installedBuildIdentity: buildIdentity,
      }).inspect();
      assert.equal(status.state, "pending");
      assert.equal(status.operationKind, "document-authoring");
      assert.equal(status.format, "document-authoring-envelope-v3");
      assert.deepEqual(status.recovery, {
        commandId: "docs-recover",
        exactFoundationVersion: version,
        exactFoundationBuildIdentity: buildIdentity,
      });
      assert.equal(status.diagnostics[0]?.code, "FOUNDATION_TRANSACTION_ACTIVE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("fails closed for a different installed build and never admits zero physical identity", async () => {
  const mismatchedRoot = await createRoot();
  const zeroRoot = await createRoot();
  try {
    await writeEnvelope(mismatchedRoot, envelopeFor("PREPARED"));
    const mismatch = await new NodeFoundationTransactionSlot({
      consumerRoot: mismatchedRoot,
      installedVersion: version,
      installedBuildIdentity: `sha256:${"3".repeat(64)}`,
    }).inspect();
    assert.equal(mismatch.state, "pending");
    assert.equal(
      mismatch.diagnostics[0]?.code,
      "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
    );

    const zero = envelopeFor("PUBLISHING");
    zero.journal.ownedTemporary.identity.ino = "0";
    zero.payloadDigest = sha256Json(zero.journal);
    const { envelopeDigest: _ignored, ...body } = zero;
    zero.envelopeDigest = sha256Json(body);
    await writeEnvelope(zeroRoot, zero);
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: zeroRoot,
      installedVersion: version,
      installedBuildIdentity: buildIdentity,
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "physical-identity-unverifiable");
  } finally {
    await rm(mismatchedRoot, { recursive: true, force: true });
    await rm(zeroRoot, { recursive: true, force: true });
  }
});

test("coordinator admits only exact document v2 recovery and blocks confused deputies", async () => {
  const exact = {
    state: "pending",
    operationKind: "document-authoring",
    format: "document-authoring-envelope-v3",
    foundationVersion: version,
    foundationBuildIdentity: buildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: version,
      exactFoundationBuildIdentity: buildIdentity,
    },
    diagnostics: [{ code: "FOUNDATION_TRANSACTION_ACTIVE", message: "pending" }],
  };
  const coordinator = new FoundationTransactionCoordinator({
    lock: { async acquire() { return async () => {}; } },
    slot: { async inspect() { return exact; } },
  });
  const lease = await coordinator.acquire({
    requestedMutation: "document-authoring",
    allowRecoveryOf: "document-authoring",
  });
  await lease.release();
  await assert.rejects(
    coordinator.acquire({
      requestedMutation: "attach",
      allowRecoveryOf: "document-authoring",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );
  await assert.rejects(
    new FoundationTransactionCoordinator({
      lock: { async acquire() { return async () => {}; } },
      slot: {
        async inspect() {
          return {
            ...exact,
            diagnostics: [{
              code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
              message: "wrong build",
            }],
          };
        },
      },
    }).acquire({
      requestedMutation: "document-authoring",
      allowRecoveryOf: "document-authoring",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
  );
  await assert.rejects(
    new FoundationTransactionCoordinator({
      lock: { async acquire() { return async () => {}; } },
      slot: {
        async inspect() {
          return {
            ...exact,
            recovery: {
              ...exact.recovery,
              exactFoundationBuildIdentity: `sha256:${"4".repeat(64)}`,
            },
          };
        },
      },
    }).acquire({
      requestedMutation: "document-authoring",
      allowRecoveryOf: "document-authoring",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );
});

test("transition residue alone is preserved and blocks every Foundation mutation", async () => {
  const root = await createRoot();
  const residue = `${slotPath(root)}.document-transition`;
  try {
    await mkdir(dirname(residue), { recursive: true });
    await writeFile(residue, "durable candidate evidence\n", "utf8");
    const before = await readFile(residue);
    const slot = new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedVersion: version,
      installedBuildIdentity: buildIdentity,
    });
    const status = await slot.inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "journal-transition-residue");
    for (const requestedMutation of [
      "attach",
      "detach",
      "document-authoring",
      "scaffolding",
    ]) {
      const coordinator = new FoundationTransactionCoordinator({
        lock: { async acquire() { return async () => {}; } },
        slot,
      });
      await assert.rejects(
        coordinator.acquire({ requestedMutation }),
        (error) => error?.code === "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      );
    }
    assert.deepEqual(await readFile(residue), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical journal plus quarantine residue preserves both and reports transition recovery", async () => {
  const root = await createRoot();
  const canonical = slotPath(root);
  const residue = `${canonical}.document-quarantine.1.2.3`;
  try {
    const envelope = envelopeFor("PREPARED");
    await writeEnvelope(root, envelope);
    await writeFile(residue, "durable quarantine evidence\n", "utf8");
    const [canonicalBefore, residueBefore] = await Promise.all([
      readFile(canonical),
      readFile(residue),
    ]);
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedVersion: version,
      installedBuildIdentity: buildIdentity,
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "journal-transition-residue");
    assert.deepEqual(await readFile(canonical), canonicalBefore);
    assert.deepEqual(await readFile(residue), residueBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired journal evidence blocks every Foundation mutation without deletion", async (context) => {
  for (const kind of ["file", "directory"]) {
    await context.test(kind, async () => {
      const root = await createRoot();
      const residue = `${slotPath(root)}.document-retired.1.2.3`;
      try {
        await mkdir(dirname(residue), { recursive: true });
        if (kind === "directory") {
          await mkdir(residue);
          await writeFile(join(residue, "evidence"), "retired evidence\n", "utf8");
        } else {
          await writeFile(residue, "retired evidence\n", "utf8");
        }
        const before = kind === "directory"
          ? await readFile(join(residue, "evidence"))
          : await readFile(residue);
        const slot = new NodeFoundationTransactionSlot({
          consumerRoot: root,
          installedVersion: version,
          installedBuildIdentity: buildIdentity,
        });
        const status = await slot.inspect();
        assert.equal(status.state, "manual-recovery-required");
        assert.equal(status.reason, "journal-transition-residue");

        for (const requestedMutation of ["document-authoring", "scaffolding"]) {
          const coordinator = new FoundationTransactionCoordinator({
            lock: { async acquire() { return async () => {}; } },
            slot,
          });
          await assert.rejects(
            coordinator.acquire({ requestedMutation }),
            (error) =>
              error?.code === "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
          );
        }

        assert.deepEqual(
          kind === "directory"
            ? await readFile(join(residue, "evidence"))
            : await readFile(residue),
          before,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
