import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NodeDocumentTransactionCoordinator } from "../packages/document-authoring/dist/adapters/node/node-document-transaction-coordinator.js";
import { canonicalJson, sha256Json } from "../packages/document-authoring/dist/canonical-json.js";
import { installedDocumentAuthoringBuildIdentity } from "../packages/document-authoring/dist/installed-artifact-identity.js";
import { installedDocumentAuthoringVersion } from "../packages/document-authoring/dist/package-version.js";
import { documentPlanDigest } from "../packages/document-authoring/dist/application/policies/document-contract-digests.js";
import { createDocumentEnvelopeV3 } from "./fixtures/document-authoring-envelope-v3.mjs";

const contract = JSON.parse(await readFile(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
  "utf8",
));
const stateDirectory = ".agent-teams-local";
const journalName = "scaffolding-transaction.json";
const lockName = "foundation-operation.lock";

for (const operation of ["apply", "recover"]) {
  test(`${operation} composition preserves the microtask before writer initialization`, () => {
    const child = spawnSync(process.execPath, [
      "--experimental-test-module-mocks",
      fileURLToPath(new URL(
        "../packages/document-authoring/tests/fixtures/writer-scheduling.mjs", import.meta.url
      )),
      operation
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { operation, outcome: "passed" });
  });
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "document-coordinator-adapter-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function installedEnvelope() {
  const envelope = createDocumentEnvelopeV3(contract);
  const installed = {
    version: await installedDocumentAuthoringVersion(),
    buildIdentity: await installedDocumentAuthoringBuildIdentity(),
  };
  envelope.foundation = installed;
  envelope.recoveryHandler.id = "document-authoring";
  envelope.journal.plan.compiler = {
    ...envelope.journal.plan.compiler,
    id: "@agent-teams/document-authoring",
    ...installed,
  };
  envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
  envelope.payloadDigest = sha256Json(envelope.journal);
  delete envelope.envelopeDigest;
  envelope.envelopeDigest = sha256Json(envelope);
  return envelope;
}

async function persistEnvelope(root, envelope) {
  const directory = join(root, stateDirectory);
  await mkdir(directory, { recursive: true });
  // This fixture writes a validated canonical journal directly so the
  // coordinator read path can be qualified on Windows, where strict directory
  // fsync is intentionally unsupported for production publication.
  await writeFile(join(directory, journalName), `${canonicalJson(envelope)}\n`, "utf8");
}

test("maps only the exact document v3 journal v2 route to recoverable", async () => {
  await withRoot(async (root) => {
    const coordinator = new NodeDocumentTransactionCoordinator(root);
    await persistEnvelope(root, await installedEnvelope());
    assert.deepEqual(await coordinator.inspect(), { state: "recoverable" });
  });

  await withRoot(async (root) => {
    const coordinator = new NodeDocumentTransactionCoordinator(root);
    await persistEnvelope(root, createDocumentEnvelopeV3(contract));
    const mismatch = await coordinator.inspect();
    assert.equal(mismatch.state, "manual-recovery-required");
    assert.match(mismatch.reason, /Document Authoring 0\.16\.0/u);
  });

  await withRoot(async (root) => {
    const directory = join(root, stateDirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, journalName), "foreign transaction evidence\n");
    const foreign = await new NodeDocumentTransactionCoordinator(root).inspect();
    assert.equal(foreign.state, "manual-recovery-required");
    assert.match(foreign.reason, /foreign, corrupt, incompatible/u);
  });
});

test("acquires an idle apply lease and an exact document recovery lease", async () => {
  await withRoot(async (root) => {
    const coordinator = new NodeDocumentTransactionCoordinator(root);
    const applyLease = await coordinator.acquire({ mode: "apply" });
    assert.deepEqual(applyLease.status, { state: "idle" });
    const active = JSON.parse(await readFile(
      join(root, stateDirectory, lockName), "utf8",
    ));
    assert.equal(active.kind, "active");
    await applyLease.release();
    await assert.rejects(readFile(join(root, stateDirectory, lockName)), {
      code: "ENOENT",
    });
  });

  await withRoot(async (root) => {
    await persistEnvelope(root, await installedEnvelope());
    const recoverLease = await new NodeDocumentTransactionCoordinator(root)
      .acquire({ mode: "recover" });
    assert.deepEqual(recoverLease.status, { state: "recoverable" });
    await recoverLease.release();
    const retained = JSON.parse(await readFile(
      join(root, stateDirectory, lockName), "utf8",
    ));
    assert.equal(retained.kind, "transaction-barrier");
  });
});

test("releases normally only after all transaction evidence is durably gone", async () => {
  await withRoot(async (root) => {
    const coordinator = new NodeDocumentTransactionCoordinator(root);
    const lease = await coordinator.acquire({ mode: "apply" });
    await persistEnvelope(root, await installedEnvelope());
    await lease.release();
    const retained = JSON.parse(await readFile(
      join(root, stateDirectory, lockName), "utf8",
    ));
    assert.equal(retained.kind, "transaction-barrier");
    await lease.release();
  });
});

test("an explicit release retention request leaves the transaction barrier", async () => {
  await withRoot(async (root) => {
    const coordinator = new NodeDocumentTransactionCoordinator(root);
    const lease = await coordinator.acquire({ mode: "apply" });
    await lease.release({ retainTransactionBarrier: true });
    const retained = JSON.parse(await readFile(
      join(root, stateDirectory, lockName), "utf8",
    ));
    assert.equal(retained.kind, "transaction-barrier");
  });
});
