import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createNodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-slot.js";
import { sha256Json } from "../packages/engineering-foundation/dist/canonical-json.js";
import {
  createDocumentEnvelopeV3,
  documentEnvelopeV3BuildIdentity,
  documentEnvelopeV3Version,
} from "./fixtures/document-authoring-envelope-v3.mjs";

const contractFixture = JSON.parse(
  await readFile(
    new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
    "utf8",
  ),
);

function slotPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function inspectEnvelope(envelope, installed = {}) {
  const root = await mkdtemp(join(tmpdir(), "document-version-compatibility-"));
  const path = slotPath(root);
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await writeFile(path, bytes);
  try {
    const status = await createNodeFoundationTransactionSlot({
      consumerRoot: root,
      installedVersion: installed.version ?? documentEnvelopeV3Version,
      installedBuildIdentity:
        installed.buildIdentity ?? documentEnvelopeV3BuildIdentity,
    }).inspect();
    assert.deepEqual(await readFile(path), bytes);
    return status;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("preserves an envelope v3 for external exact Foundation recovery", async () => {
  const envelope = createDocumentEnvelopeV3(contractFixture);
  const exact = await inspectEnvelope(envelope);
  assert.equal(exact.state, "manual-recovery-required");
  assert.equal(exact.recovery, undefined);
  assert.match(exact.diagnostics[0]?.message, /Claimed @agent-teams\/engineering-foundation/u);

  for (const installed of [
    { version: "0.15.0", buildIdentity: documentEnvelopeV3BuildIdentity },
    {
      version: documentEnvelopeV3Version,
      buildIdentity: `sha256:${"3".repeat(64)}`,
    },
  ]) {
    const mismatch = await inspectEnvelope(envelope, installed);
    assert.deepEqual(mismatch, exact);
  }
});

test("preserves envelope v2 document journal v1 as manual-only evidence", async () => {
  const current = createDocumentEnvelopeV3(contractFixture);
  const body = {
    ...current,
    schemaVersion: 2,
    recoveryHandler: {
      id: "foundation.document-authoring",
      contractVersion: 1,
    },
    payloadKind: "document-authoring-journal/v1",
    journal: { ...current.journal, schemaVersion: 1 },
  };
  body.payloadDigest = sha256Json(body.journal);
  delete body.envelopeDigest;
  const envelopeV2 = { ...body, envelopeDigest: sha256Json(body) };
  const legacy = await inspectEnvelope(envelopeV2);
  assert.equal(legacy.state, "manual-recovery-required");
  assert.equal(legacy.reason, "recovery-handler-unavailable");
  assert.equal(legacy.format, "envelope-v2");
  assert.equal(legacy.operationKind, "document-authoring");
});
