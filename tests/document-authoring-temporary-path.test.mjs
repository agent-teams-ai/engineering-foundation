import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { documentPlanDigest } from "../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../packages/document-authoring/dist/document-authoring/application/policies/document-temporary-path.js";
import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";
import { NodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import { sha256Json } from "../packages/engineering-foundation/dist/canonical-json.js";
import { createDocumentEnvelopeV3 } from "./fixtures/document-authoring-envelope-v3.mjs";

const fixture = JSON.parse(await readFile(fileURLToPath(new URL(
  "fixtures/document-authoring-contracts/valid-v1.json",
  import.meta.url,
)), "utf8"));

async function inspectPublishingEnvelope(temporaryPath, mutateIdentity = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "document-authoring-temporary-"));
  const envelope = structuredClone(fixture.documentEnvelope);
  envelope.journal.plan = structuredClone(fixture.plan);
  envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
  envelope.foundation.version = envelope.journal.plan.compiler.version;
  envelope.foundation.buildIdentity = envelope.journal.plan.compiler.buildIdentity;
  envelope.state = "PUBLISHING";
  envelope.journal.destination.state = "publishing";
  envelope.journal.ownedTemporary = {
    path: temporaryPath(envelope.journal.plan),
    digest: envelope.journal.plan.output.digest,
    identity: {
      adapter: "node-filesystem",
      version: 1,
      dev: "1",
      ino: "2",
      birthtimeNs: "3",
    },
  };
  mutateIdentity(envelope.journal.ownedTemporary.identity);
  envelope.payloadDigest = sha256Json(envelope.journal);
  const { envelopeDigest: _digest, ...body } = envelope;
  envelope.envelopeDigest = sha256Json(body);
  const path = join(root, ".agent-teams-local", "scaffolding-transaction.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
  try {
    return await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity: envelope.foundation.buildIdentity,
      installedVersion: envelope.foundation.version,
    }).inspect();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("accepts the exact digest-derived bounded document temporary", async () => {
  const status = await inspectPublishingEnvelope((plan) =>
    documentTemporaryPath(plan.destination, plan.planDigest));
  assert.equal(status.state, "manual-recovery-required");
  assert.equal(status.reason, "recovery-handler-unavailable");
});

test("rejects a document temporary that is not the exact derived path", async () => {
  const status = await inspectPublishingEnvelope((plan) =>
    `${plan.destination}.foundation-document.tmp`);
  assert.equal(status.state, "manual-recovery-required");
  assert.equal(status.reason, "corrupt-or-incompatible");
});

test("rejects a forged or missing temporary physical identity", async (context) => {
  for (const [name, mutate] of [
    ["missing", (identity) => { delete identity.adapter; }],
    ["forged adapter", (identity) => { identity.adapter = "forged"; }],
    ["non-canonical inode", (identity) => { identity.ino = "01"; }],
  ]) {
    await context.test(name, async () => {
      const status = await inspectPublishingEnvelope((plan) => {
        return documentTemporaryPath(plan.destination, plan.planDigest);
      }, mutate);
      assert.equal(status.state, "manual-recovery-required");
      assert.equal(status.reason, "corrupt-or-incompatible");
    });
  }
});

test("preserves a canonical zero identity as unverifiable manual evidence", async () => {
  const status = await inspectPublishingEnvelope(
    (plan) => documentTemporaryPath(plan.destination, plan.planDigest),
    (identity) => { identity.ino = "0"; },
  );
  assert.equal(status.state, "manual-recovery-required");
  assert.equal(status.reason, "physical-identity-unverifiable");
  assert.equal(status.operationKind, "document-authoring");
  assert.equal(status.format, "envelope-v2");
  assert.match(status.diagnostics[0].message, /cannot authorize automatic recovery/u);
});

test("schema requires a closed creator-handle identity", async (context) => {
  for (const [name, mutate] of [
    ["missing", (identity) => { delete identity.adapter; }],
    ["forged adapter", (identity) => { identity.adapter = "forged"; }],
    ["non-canonical zero inode", (identity) => { identity.ino = "00"; }],
    ["open shape", (identity) => { identity.extra = "open"; }],
  ]) {
    await context.test(name, async () => {
      const envelope = createDocumentEnvelopeV3(fixture, "PUBLISHING");
      const identity = { ...envelope.journal.ownedTemporary.identity };
      mutate(identity);
      envelope.journal.ownedTemporary.identity = identity;
      await assert.rejects(
        assertSchema("foundation-transaction-envelope/v3", envelope, name),
        (error) => error?.problem?.code === "SCHEMA_INVALID",
      );
    });
  }
});

test("schema accepts canonical unsigned zero identity fields", async () => {
  const envelope = createDocumentEnvelopeV3(fixture, "PUBLISHING");
  envelope.journal.ownedTemporary.identity = {
    adapter: "node-filesystem", version: 1,
    dev: "0", ino: "0", birthtimeNs: "0",
  };
  await assertSchema("foundation-transaction-envelope/v3", envelope, "zero-identity");
});
