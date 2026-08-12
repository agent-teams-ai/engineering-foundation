import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import { NodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  recoverFilesystemScaffold,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { sha256Json } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const coordinatorModulePath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "transaction-coordination",
  "adapters",
  "node",
  "node-foundation-transaction-coordinator.js",
);
const transactionHolderFixture = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "foundation-transaction-holder.mjs",
);
const legacyFoundationReaderFixture = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "legacy-foundation-scaffold-reader-0.11.mjs",
);
const scaffoldFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer",
);
const documentFixture = JSON.parse(
  await readFile(
    join(
      repositoryRoot,
      "tests",
      "fixtures",
      "document-authoring-contracts",
      "valid-v1.json",
    ),
    "utf8",
  ),
);

async function createRoot(prefix = "foundation-transaction-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function slotPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function startTransactionHolder(root, mutation) {
  const child = spawn(
    process.execPath,
    [transactionHolderFixture, coordinatorModulePath, root, mutation],
    { stdio: ["ignore", "pipe", "pipe"] },
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
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

function buildDocumentEnvelope(version = "0.12.0") {
  const envelope = structuredClone(documentFixture.documentEnvelope);
  envelope.foundation.version = version;
  envelope.journal.plan = structuredClone(documentFixture.plan);
  envelope.journal.plan.compiler.version = version;
  const { planDigest: _planDigest, ...planBody } = envelope.journal.plan;
  envelope.journal.plan.planDigest = sha256Json(planBody);
  envelope.payloadDigest = sha256Json(envelope.journal);
  const { envelopeDigest: _envelopeDigest, ...envelopeBody } = envelope;
  envelope.envelopeDigest = sha256Json(envelopeBody);
  return envelope;
}

function coordinatorWith(status) {
  let releaseCount = 0;
  return {
    coordinator: new FoundationTransactionCoordinator({
      lock: {
        async acquire() {
          return async () => {
            releaseCount += 1;
          };
        },
      },
      slot: {
        async inspect() {
          return status;
        },
      },
    }),
    releaseCount: () => releaseCount,
  };
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

  const genericEnvelope = coordinatorWith({ ...status, format: "envelope-v2" });
  await assert.rejects(
    genericEnvelope.coordinator.acquire({
      requestedMutation: "scaffolding",
      allowRecoveryOf: "scaffolding",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );
});

test("never grants recovery to a mismatched Foundation package version", async () => {
  const status = {
    state: "pending",
    operationKind: "document-authoring",
    format: "envelope-v2",
    foundationVersion: "0.13.0",
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: "0.13.0",
    },
    diagnostics: [
      {
        code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
        message: "use 0.13.0",
      },
    ],
  };
  const fixture = coordinatorWith(status);
  await assert.rejects(
    fixture.coordinator.acquire({
      requestedMutation: "document-authoring",
      allowRecoveryOf: "document-authoring",
    }),
    (error) => error?.code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
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
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
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

test("recognizes a verified envelope v2 and reports package version drift", async () => {
  const root = await createRoot();
  try {
    await writeJson(slotPath(root), buildDocumentEnvelope("0.12.0"));
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedVersion: "0.13.0",
    }).inspect();
    assert.equal(status.state, "pending");
    assert.equal(status.operationKind, "document-authoring");
    assert.equal(status.recovery.exactFoundationVersion, "0.12.0");
    assert.equal(
      status.diagnostics[0]?.code,
      "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a frozen Foundation 0.11 reader fails closed on envelope v2", async () => {
  const root = await createRoot();
  try {
    const path = slotPath(root);
    await writeJson(path, buildDocumentEnvelope());
    const before = await readFile(path);
    const result = spawnSync(process.execPath, [legacyFoundationReaderFixture, path], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SCAFFOLD_RECOVERY_REQUIRED/u);
    assert.deepEqual(await readFile(path), before);
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
        const before = await stat(
          scenario.name === "orphan temporary" ? `${slotPath(root)}.tmp` : slotPath(root),
        );
        const status = await new NodeFoundationTransactionSlot({
          consumerRoot: root,
          installedVersion: "0.12.0",
        }).inspect();
        assert.equal(status.state, "manual-recovery-required");
        const after = await stat(
          scenario.name === "orphan temporary" ? `${slotPath(root)}.tmp` : slotPath(root),
        );
        assert.equal(String(after.ino), String(before.ino));
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
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
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

test("detects transaction replacement between lock acquisition and inspection", async () => {
  const root = await createRoot();
  try {
    const initial = buildDocumentEnvelope("0.12.0");
    await writeJson(slotPath(root), initial);
    const coordinator = new FoundationTransactionCoordinator({
      lock: {
        async acquire() {
          const path = slotPath(root);
          const source = await readFile(path);
          await rename(path, `${path}.original`);
          await writeFile(path, source);
          return async () => {};
        },
      },
      slot: new NodeFoundationTransactionSlot({
        consumerRoot: root,
        installedVersion: "0.12.0",
      }),
    });
    await assert.rejects(
      coordinator.acquire({ requestedMutation: "attach" }),
      (error) => error?.code === "FOUNDATION_TRANSACTION_ACTIVE",
    );
    assert.equal((await stat(slotPath(root))).isFile(), true);
    assert.equal((await stat(`${slotPath(root)}.original`)).isFile(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "serializes cross-kind child processes with the shared repository lock",
  { timeout: 10_000 },
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
