import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  inspectDocumentTransactionV1,
  inspectDocumentTransactionV2,
} from "../packages/document-authoring/dist/index.js";
import { canonicalJson, sha256Json } from "../packages/repository-mutation/dist/index.js";
import { installedDocumentAuthoringBuildIdentity } from "../packages/document-authoring/dist/document-authoring/adapters/node/installed-artifact-identity.js";
import { installedDocumentAuthoringVersion } from "../packages/document-authoring/dist/document-authoring/adapters/node/package-version.js";
import { documentPlanDigest } from "../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
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
  // Keep inspection fixtures writable on Windows; production journal creation
  // still enforces strict directory durability before publication.
  await writeFile(path, `${canonicalJson(envelope)}\n`, "utf8");
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

test("Document Authoring inspection classifies transition residue portably", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  try {
    const stateDirectory = join(root, ".agent-teams-local");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "scaffolding-transaction.json.document-transition"),
      "preserved transition evidence\n",
      "utf8",
    );
    for (const inspect of [inspectDocumentTransactionV2, inspectDocumentTransactionV1]) {
      const status = await inspect(root);
      assert.equal(status.state, "manual-recovery-required");
      assert.equal(status.reason, "journal-transition-residue");
    }
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
