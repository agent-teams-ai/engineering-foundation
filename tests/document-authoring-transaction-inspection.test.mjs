import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  inspectDocumentTransactionV1,
  inspectDocumentTransactionV2,
} from "../packages/document-authoring/dist/index.js";
import { sha256Json } from "../packages/document-authoring/dist/canonical-json.js";
import { installedDocumentAuthoringBuildIdentity } from "../packages/document-authoring/dist/installed-artifact-identity.js";
import { installedDocumentAuthoringVersion } from "../packages/document-authoring/dist/package-version.js";
import { documentPlanDigest } from "../packages/document-authoring/dist/application/policies/document-contract-digests.js";
import { NodeDocumentJournalStore } from "../packages/document-authoring/dist/adapters/node/node-document-journal-store.js";
import { createDocumentEnvelopeV3 } from "./fixtures/document-authoring-envelope-v3.mjs";

const fixture = JSON.parse(await readFile(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
  "utf8",
));

async function installedEnvelope() {
  const envelope = createDocumentEnvelopeV3(fixture);
  const installed = {
    version: await installedDocumentAuthoringVersion(),
    buildIdentity: await installedDocumentAuthoringBuildIdentity(),
  };
  envelope.foundation = installed;
  envelope.journal.plan.compiler = {
    ...envelope.journal.plan.compiler,
    id: "@agent-teams/document-authoring",
    ...installed,
  };
  envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
  envelope.payloadDigest = sha256Json(envelope.journal);
  delete envelope.envelopeDigest;
  envelope.envelopeDigest = sha256Json(envelope);
  return { envelope, installed };
}

async function writeEnvelope(root, envelope) {
  const path = join(root, ".agent-teams-local", "scaffolding-transaction.json");
  await mkdir(dirname(path), { recursive: true });
  await new NodeDocumentJournalStore(path).create(envelope);
}

test("Document Authoring inspection exposes exact owner-package recovery coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  try {
    const { envelope, installed } = await installedEnvelope();
    await writeEnvelope(root, envelope);

    const current = await inspectDocumentTransactionV2(root);
    assert.equal(current.schemaVersion, 2);
    assert.equal(current.state, "recoverable");
    assert.equal(current.recovery.commandId, "docs-recover");
    assert.equal(current.recovery.exactFoundationVersion, installed.version);
    assert.equal(
      current.recovery.exactFoundationBuildIdentity,
      installed.buildIdentity,
    );

    const legacy = await inspectDocumentTransactionV1(root);
    assert.equal(legacy.schemaVersion, 1);
    assert.equal(legacy.state, "recoverable");
    assert.equal(legacy.recovery.exactFoundationVersion, installed.version);
    assert.equal(
      legacy.recovery.exactFoundationBuildIdentity,
      installed.buildIdentity,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Document Authoring inspection rejects a transaction owned by another exact build", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  try {
    const envelope = createDocumentEnvelopeV3(fixture);
    await writeEnvelope(root, envelope);
    const status = await inspectDocumentTransactionV2(root);
    assert.equal(status.schemaVersion, 2);
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.transactionKind, "version-mismatch");
    assert.match(status.reason, /Document Authoring 0\.16\.0/u);
    assert.deepEqual(status.recovery, {
      commandId: "docs-recover",
      args: {
        exactFoundationVersion: envelope.foundation.version,
        exactFoundationBuildIdentity: envelope.foundation.buildIdentity,
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Document Authoring inspection reports an absent state directory as idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  try {
    assert.deepEqual(await inspectDocumentTransactionV2(root), {
      schemaVersion: 2,
      state: "idle",
      diagnostics: [],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Document Authoring inspection never follows a redirected state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  const outside = await mkdtemp(join(tmpdir(), "document-public-inspection-outside-"));
  try {
    const { envelope } = await installedEnvelope();
    await writeFile(
      join(outside, "scaffolding-transaction.json"),
      `${JSON.stringify(envelope)}\n`,
      "utf8",
    );
    await symlink(
      outside,
      join(root, ".agent-teams-local"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const status = await inspectDocumentTransactionV2(root);
    assert.equal(status.state, "manual-recovery-required");
    assert.match(status.reason, /redirected|safely/u);
    assert.equal("recovery" in status, false);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});
