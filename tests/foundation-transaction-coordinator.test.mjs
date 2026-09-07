import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { createRoot, slotPath, writeJson, observeEvidence, buildDocumentEnvelope, coordinatorWith, installedBuildIdentity } from "./support/foundation-transaction-observation-fixtures.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import { createNodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-slot.js";
import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";
import {
  documentPlanDigest,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  recoverFilesystemScaffold,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { sha256Json } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { readBoundedRegularFile } from "../packages/repository-mutation/dist/qualification/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const coordinatorModulePath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "composition",
  "node-foundation-transaction-coordinator.js",
);
const transactionHolderFixture = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "foundation-transaction-holder.mjs",
);
const scaffoldFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer",
);


async function startTransactionHolder(root, mutation) {
  const child = spawn(
    process.execPath,
    [transactionHolderFixture, coordinatorModulePath, root, mutation],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      reject(new Error(`transaction holder exited with ${String(code)}: ${stderr}`));
    });
    child.once("error", reject);
  });
  return child;
}

async function stopTransactionHolder(child) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    const failureTimer = setTimeout(() => {
      reject(new Error("transaction holder did not stop after graceful and forced shutdown"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      reject(error);
    });
    child.stdin.end("STOP\n");
  });
}

test("serializes an idle mutation and releases its physical lock exactly once", async () => {
  const fixture = coordinatorWith({ state: "idle", diagnostics: [] });
  const lease = await fixture.coordinator.acquire({
    requestedMutation: "document-authoring",
  });
  assert.equal(lease.status.state, "idle");
  await lease.release();
  await lease.release();
  assert.equal(fixture.releaseCount(), 1);
});

test("preserves the classified transaction failure when lock release also fails", async () => {
  const releaseFailure = new Error("lock release failed");
  const status = {
    state: "pending",
    operationKind: "scaffolding",
    format: "envelope-v2",
    diagnostics: [
      {
        code: "FOUNDATION_TRANSACTION_ACTIVE",
        message: "pending scaffold",
      },
    ],
  };
  const coordinator = new FoundationTransactionCoordinator({
    lock: {
      async acquire() {
        return async () => {
          throw releaseFailure;
        };
      },
    },
    slot: {
      async inspect() {
        return status;
      },
    },
  });

  await assert.rejects(
    coordinator.acquire({ requestedMutation: "attach" }),
    (error) => {
      assert.ok(error instanceof FoundationTransactionError);
      assert.equal(error.code, "FOUNDATION_TRANSACTION_ACTIVE");
      assert.equal(error.message, "pending scaffold");
      assert.equal(error.status, status);
      assert.equal(error.cause, releaseFailure);
      return true;
    },
  );
});

test("blocks foreign transactions and preserves the exact recovery route", async () => {
  const status = {
    state: "pending",
    operationKind: "scaffolding",
    format: "legacy-scaffolding-v1",
    foundationVersion: "0.12.0",
    recovery: {
      commandId: "scaffold-recover",
      exactFoundationVersion: "0.12.0",
    },
    diagnostics: [
      {
        code: "FOUNDATION_TRANSACTION_ACTIVE",
        message: "pending scaffold",
      },
    ],
  };
  const fixture = coordinatorWith(status);
  await assert.rejects(
    fixture.coordinator.acquire({ requestedMutation: "attach" }),
    (error) => {
      assert.ok(error instanceof FoundationTransactionError);
      assert.equal(error.status.recovery.commandId, "scaffold-recover");
      return true;
    },
  );
  assert.equal(fixture.releaseCount(), 1);

  const recovery = coordinatorWith(status);
  const lease = await recovery.coordinator.acquire({
    requestedMutation: "scaffolding",
    allowRecoveryOf: "scaffolding",
  });
  await lease.release();
  assert.equal(recovery.releaseCount(), 1);

  const confusedDeputy = coordinatorWith(status);
  await assert.rejects(
    confusedDeputy.coordinator.acquire({
      requestedMutation: "attach",
      allowRecoveryOf: "scaffolding",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );

  const genericEnvelope = coordinatorWith({ ...status, format: "envelope-v2" });
  await assert.rejects(
    genericEnvelope.coordinator.acquire({
      requestedMutation: "scaffolding",
      allowRecoveryOf: "scaffolding",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );
});

test("never grants recovery to envelope v2 before its handler is qualified", async () => {
  const status = {
    state: "manual-recovery-required",
    reason: "recovery-handler-unavailable",
    operationKind: "document-authoring",
    format: "envelope-v2",
    foundationVersion: "0.13.0",
    foundationBuildIdentity: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    diagnostics: [
      {
        code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
        message: "recovery handler unavailable",
      },
    ],
  };
  const fixture = coordinatorWith(status);
  await assert.rejects(
    fixture.coordinator.acquire({
      requestedMutation: "document-authoring",
      allowRecoveryOf: "document-authoring",
    }),
    (error) =>
      error?.code === "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
  );
});

test("recognizes a frozen legacy scaffolding v1 journal and its exact compiler", async () => {
  const root = await createRoot();
  try {
    await cp(scaffoldFixtureRoot, root, { recursive: true });
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: "intents/create-fixture.yaml",
    });
    const journal = {
      schemaVersion: 1,
      state: "PREPARED",
      plan,
      operations: plan.operations.map((operation) => ({
        operationId: operation.id,
        path: operation.path,
        state: "pending",
      })),
    };
    await writeJson(slotPath(root), journal);
    const status = await createNodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: plan.compiler.version,
    }).inspect();
    assert.deepEqual(
      {
        state: status.state,
        operationKind: status.operationKind,
        format: status.format,
        foundationVersion: status.foundationVersion,
        recovery: status.recovery,
      },
      {
        state: "pending",
        operationKind: "scaffolding",
        format: "legacy-scaffolding-v1",
        foundationVersion: plan.compiler.version,
        recovery: {
          commandId: "scaffold-recover",
          exactFoundationVersion: plan.compiler.version,
        },
      },
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("preserves exact verified envelope v2 evidence until its recovery handler exists", async () => {
  const root = await createRoot();
  try {
    await writeJson(slotPath(root), buildDocumentEnvelope("0.12.0"));
    const status = await createNodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.13.0",
    }).inspect();
    assert.deepEqual(
      {
        state: status.state,
        reason: status.reason,
        operationKind: status.operationKind,
        format: status.format,
        foundationVersion: status.foundationVersion,
        foundationBuildIdentity: status.foundationBuildIdentity,
        recovery: status.recovery,
      },
      {
        state: "manual-recovery-required",
        reason: "recovery-handler-unavailable",
        operationKind: "document-authoring",
        format: "envelope-v2",
        foundationVersion: "0.12.0",
        foundationBuildIdentity: installedBuildIdentity,
        recovery: undefined,
      },
    );
    assert.equal(
      status.diagnostics[0]?.code,
      "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts the schema-defined preexisting document lifecycle", async () => {
  const root = await createRoot();
  try {
    const envelope = buildDocumentEnvelope();
    envelope.journal.destination.state = "preexisting";
    envelope.payloadDigest = sha256Json(envelope.journal);
    const { envelopeDigest: _digest, ...body } = envelope;
    envelope.envelopeDigest = sha256Json(body);
    await writeJson(slotPath(root), envelope);
    const status = await createNodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.12.0",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "recovery-handler-unavailable");
    assert.equal(status.operationKind, "document-authoring");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when an envelope is rebound across compiler or installed builds", async (context) => {
  const otherBuildIdentity = `sha256:${"f".repeat(64)}`;
  const scenarios = [
    {
      name: "outer and document compiler version differ",
      mutate(envelope) {
        envelope.journal.plan.compiler.version = "0.13.0";
      },
    },
    {
      name: "outer and document compiler build differ",
      mutate(envelope) {
        envelope.journal.plan.compiler.buildIdentity = otherBuildIdentity;
      },
    },
    {
      name: "document plan digest is invalid",
      mutate(envelope) {
        envelope.journal.plan.projectId = "forged-project";
      },
    },
    {
      name: "intent digest does not bind the embedded intent",
      mutate(envelope) {
        envelope.journal.plan.intent.title = "Rebound intent";
        envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
      },
    },
    {
      name: "journal destination differs from the Plan",
      mutate(envelope) {
        envelope.journal.destination.path = "docs/decisions/0084-rebound.md";
      },
    },
    {
      name: "output size does not bind decoded output bytes",
      mutate(envelope) {
        envelope.journal.plan.output.size += 1;
        envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
      },
    },
    {
      name: "owned temporary does not bind the exact output",
      mutate(envelope) {
        envelope.journal.ownedTemporary = {
          path: `${envelope.journal.plan.destination}.foundation-document.tmp`,
          digest: `sha256:${"e".repeat(64)}`,
        };
      },
    },
    {
      name: "PREPARED envelope claims a published destination",
      mutate(envelope) {
        envelope.journal.destination.state = "published";
      },
    },
    {
      name: "PUBLISHED envelope retains a pending destination",
      mutate(envelope) {
        envelope.state = "PUBLISHED";
      },
    },
    {
      name: "PUBLISHING envelope has no owned temporary",
      mutate(envelope) {
        envelope.state = "PUBLISHING";
        envelope.journal.destination.state = "publishing";
      },
    },
    {
      name: "PREPARED envelope already owns a temporary",
      mutate(envelope) {
        envelope.journal.ownedTemporary = {
          path: `${envelope.journal.plan.destination}.foundation-document.tmp`,
          digest: envelope.journal.plan.output.digest,
        };
      },
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const root = await createRoot();
      try {
        const envelope = buildDocumentEnvelope();
        scenario.mutate(envelope);
        envelope.payloadDigest = sha256Json(envelope.journal);
        const { envelopeDigest: _digest, ...body } = envelope;
        envelope.envelopeDigest = sha256Json(body);
        await writeJson(slotPath(root), envelope);
        const before = await readFile(slotPath(root));
        const status = await createNodeFoundationTransactionSlot({
          consumerRoot: root,
          installedBuildIdentity,
          installedVersion: "0.12.0",
        }).inspect();
        assert.equal(status.state, "manual-recovery-required");
        assert.deepEqual(await readFile(slotPath(root)), before);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }

  await context.test("installed build identity differs at the same version", async () => {
    const root = await createRoot();
    try {
      await writeJson(slotPath(root), buildDocumentEnvelope());
      const status = await createNodeFoundationTransactionSlot({
        consumerRoot: root,
        installedBuildIdentity: otherBuildIdentity,
        installedVersion: "0.12.0",
      }).inspect();
      assert.equal(status.state, "manual-recovery-required");
      assert.equal(status.reason, "recovery-handler-unavailable");
      assert.equal(
        status.diagnostics[0]?.code,
        "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      );
      assert.equal(
        status.foundationBuildIdentity,
        installedBuildIdentity,
      );
      assert.equal(status.foundationVersion, "0.12.0");
      assert.equal(status.recovery, undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

test("rejects a schema-valid legacy journal whose operation evidence is not Plan-bound", async () => {
  const root = await createRoot();
  try {
    await cp(scaffoldFixtureRoot, root, { recursive: true });
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: "intents/create-fixture.yaml",
    });
    const journal = {
      schemaVersion: 1,
      state: "PREPARED",
      plan,
      operations: plan.operations.map((operation) => ({
        operationId: operation.id,
        path: `${operation.path}.forged`,
        state: "pending",
      })),
    };
    await writeJson(slotPath(root), journal);
    const before = await readFile(slotPath(root));
    const status = await createNodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: plan.compiler.version,
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.deepEqual(await readFile(slotPath(root)), before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed and preserves unknown, corrupt, replaced, and temporary evidence", async (context) => {
  const scenarios = [
    {
      name: "unknown version",
      prepare: async (root) =>
        writeJson(slotPath(root), { schemaVersion: 99, future: true }),
    },
    {
      name: "corrupt source",
      prepare: async (root) => writeFile(slotPath(root), "{\"schemaVersion\":2,", "utf8"),
    },
    {
      name: "UTF-8 BOM source",
      prepare: async (root) =>
        writeFile(slotPath(root), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]))
    },
    {
      name: "invalid UTF-8 source",
      prepare: async (root) =>
        writeFile(slotPath(root), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]))
    },
    {
      name: "duplicate JSON key",
      prepare: async (root) =>
        writeFile(slotPath(root), '{"schemaVersion":2,"schemaVersion":99}\n', "utf8")
    },
    {
      name: "non-regular slot",
      prepare: async (root) => mkdir(slotPath(root), { recursive: true }),
    },
    {
      name: "orphan temporary",
      prepare: async (root) =>
        writeFile(`${slotPath(root)}.tmp`, "third-party\n", "utf8"),
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const root = await createRoot();
      try {
        await mkdir(dirname(slotPath(root)), { recursive: true });
        await scenario.prepare(root);
        const path =
          scenario.name === "orphan temporary" ? `${slotPath(root)}.tmp` : slotPath(root);
        const before = await observeEvidence(path);
        const absentBefore = await observeEvidence(
          scenario.name === "orphan temporary" ? slotPath(root) : `${slotPath(root)}.tmp`,
        );
        const status = await createNodeFoundationTransactionSlot({
          consumerRoot: root,
          installedBuildIdentity,
          installedVersion: "0.12.0",
        }).inspect();
        assert.equal(status.state, "manual-recovery-required");
        assert.equal(
          status.reason,
          scenario.name === "orphan temporary"
            ? "orphan-temporary"
            : scenario.name === "unknown version"
              ? "unsupported-schema"
              : scenario.name === "non-regular slot"
                ? "unstable-slot"
                : "corrupt-or-incompatible",
        );
        assert.deepEqual(await observeEvidence(path), before);
        assert.deepEqual(
          await observeEvidence(
            scenario.name === "orphan temporary" ? slotPath(root) : `${slotPath(root)}.tmp`,
          ),
          absentBefore,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

test("preserves both journal and temporary evidence when the slot has two candidates", async () => {
  const root = await createRoot();
  try {
    const path = slotPath(root);
    await writeJson(path, buildDocumentEnvelope());
    await writeFile(`${path}.tmp`, "independent candidate\n", "utf8");
    const journalBefore = await readFile(path);
    const temporaryBefore = await readFile(`${path}.tmp`);
    const status = await createNodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.12.0",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.deepEqual(await readFile(path), journalBefore);
    assert.deepEqual(await readFile(`${path}.tmp`), temporaryBefore);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("blocks scaffold apply on a document envelope without deleting it", async () => {
  const root = await createRoot("foundation-transaction-scaffold-");
  try {
    await cp(scaffoldFixtureRoot, root, { recursive: true });
    const envelope = buildDocumentEnvelope("0.12.0");
    await writeJson(slotPath(root), envelope);
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: "intents/create-fixture.yaml",
    });
    const original = await readFile(slotPath(root));
    await assert.rejects(
      applyFilesystemScaffold(root, plan),
      (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED",
    );
    await assert.rejects(
      recoverFilesystemScaffold(root),
      (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED",
    );
    assert.deepEqual(await readFile(slotPath(root)), original);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("detects transaction replacement during its stable bounded read", async () => {
  const root = await createRoot();
  try {
    const initial = buildDocumentEnvelope("0.12.0");
    await writeJson(slotPath(root), initial);
    const path = slotPath(root);
    const before = await readFile(path);
    const observation = await readBoundedRegularFile(
      path,
      32 * 1024 * 1024,
      async ({ phase }) => {
        assert.equal(phase, "before-stability-check");
        await rename(path, `${path}.original`);
        await writeFile(path, before);
      },
    );
    assert.deepEqual(observation, { outcome: "changed" });
    assert.deepEqual(await observeEvidence(path), {
      exists: true,
      type: "file",
      bytes: before,
    });
    assert.deepEqual(await observeEvidence(`${path}.original`), {
      exists: true,
      type: "file",
      bytes: before,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "serializes cross-kind child processes with the shared repository lock",
  { timeout: 30_000 },
  async () => {
    const root = await createRoot();
    let holder;
    try {
      const second = await createNodeFoundationTransactionCoordinator(root);
      holder = await startTransactionHolder(root, "scaffolding");
      await assert.rejects(
        second.acquire({ requestedMutation: "document-authoring" }),
        /operation is active or its lock is not safely recoverable/u,
      );
      await stopTransactionHolder(holder);
      const nextLease = await second.acquire({
        requestedMutation: "document-authoring",
      });
      await nextLease.release();
    } finally {
      if (holder !== undefined) {
        await stopTransactionHolder(holder);
      }
      await rm(root, { force: true, recursive: true });
    }
  },
);


test("physical transaction slot delegates payload meaning to its supplied inspector", async () => {
  const { NodeFoundationTransactionSlot } = await import("../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-slot.js");
  const root = await createRoot();
  const value = { schemaVersion: 999, opaque: "test-owned inspection" };
  const expected = { state: "manual-recovery-required", reason: "unsupported-schema", diagnostics: [] };
  try {
    await writeJson(slotPath(root), value);
    let calls = 0;
    const slot = new NodeFoundationTransactionSlot({
      consumerRoot: root,
      inspection: { inspect: async (observed) => {
        calls += 1;
        assert.deepEqual(observed, value);
        return expected;
      } }
    });
    assert.deepEqual(await slot.inspect(), expected);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(await readFile(slotPath(root), "utf8")), value);
    const failing = new NodeFoundationTransactionSlot({
      consumerRoot: root, inspection: { inspect: async () => { throw new Error("unverifiable"); } }
    });
    assert.equal((await failing.inspect()).reason, "corrupt-or-incompatible");
    assert.deepEqual(JSON.parse(await readFile(slotPath(root), "utf8")), value);
  } finally { await rm(root, { recursive: true, force: true }); }
});
