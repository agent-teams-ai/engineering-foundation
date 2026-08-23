import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyKnownFileTransaction,
  compileKnownFileTransactionPlan,
  recoverKnownFileTransaction
} from "../packages/engineering-foundation/dist/mutation/index.js";
import { compileKnownFileTransactionEnvelope } from "../packages/engineering-foundation/dist/repository-mutation/application/policies/known-file-transaction-envelope.js";
import { createScriptedSequence } from "./support/scripted-sequence.mjs";

const posixTest = process.platform === "win32" ? test.skip : test;
const journalPath = (root) => join(
  root,
  ".agent-teams-local",
  "scaffolding-transaction.json"
);
const identityKeys = ["birthtimeNs", "dev", "ino"];
const operationPoint = (phase, path) => ({ operationIndex: 0, path, phase });

function createPlan({ nested = false } = {}) {
  return compileKnownFileTransactionPlan({ operations: [{
    path: nested ? "nested/result.txt" : "managed/existing.txt",
    precondition: nested
      ? { state: "absent" }
      : {
          state: "known-file",
          acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }]
        },
    postimage: {
      bytes: Buffer.from(nested ? "result\n" : "new\n"),
      mode: 0o640
    }
  }] });
}

async function createFixture({ nested = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-characterization-"));
  if (!nested) {
    await mkdir(join(root, "managed"));
    await writeFile(join(root, "managed", "existing.txt"), "old\n", { mode: 0o640 });
  }
  return { plan: createPlan({ nested }), root };
}

function scriptedCrash(expectedPoints, label) {
  const sequence = createScriptedSequence(expectedPoints, label);
  const terminal = expectedPoints.at(-1);
  return {
    assertConsumed: sequence.assertConsumed,
    faultInjector(point) {
      sequence.consume(point);
      if (point.phase === terminal.phase && point.path === terminal.path) {
        throw new Error(`characterization-stop:${terminal.phase}`);
      }
    }
  };
}

function assertIdentityShape(identity, label) {
  assert.deepEqual(Object.keys(identity).toSorted(), identityKeys, label);
  for (const value of Object.values(identity)) {
    assert.match(value, /^\d+$/u, label);
  }
}

async function readJournal(root) {
  const envelope = JSON.parse(await readFile(journalPath(root), "utf8"));
  assert.deepEqual(Object.keys(envelope).toSorted(), [
    "adapterContractVersion",
    "envelopeDigest",
    "foundation",
    "journal",
    "operationKind",
    "payloadDigest",
    "payloadKind",
    "recoveryHandler",
    "schemaVersion",
    "state"
  ]);
  assert.deepEqual(Object.keys(envelope.journal).toSorted(), [
    "authorizedDirectories",
    "createdDirectories",
    "operations",
    "plan",
    "schemaVersion"
  ]);
  assert.deepEqual(
    compileKnownFileTransactionEnvelope({
      foundation: envelope.foundation,
      journal: envelope.journal,
      state: envelope.state
    }),
    envelope,
    "journal digests and canonical envelope body must round-trip"
  );
  return envelope;
}

function assertOperationShape(operation, expected) {
  assert.equal(operation.state, expected.state);
  assert.deepEqual(Object.keys(operation).toSorted(), expected.keys);
  for (const key of [
    "captureDirectoryIdentity",
    "capturedPreimageIdentity",
    "rollbackTemporaryIdentity",
    "temporaryIdentity"
  ]) {
    if (operation[key] !== undefined) {
      assertIdentityShape(operation[key], `${key} must remain a portable identity`);
    }
  }
  if (expected.retirement !== undefined) {
    assert.equal(operation.retirement.state, expected.retirement);
    assert.deepEqual(Object.keys(operation.retirement).toSorted(), [
      "directoryIdentity",
      "kind",
      "pathIdentity",
      "state"
    ]);
    assertIdentityShape(operation.retirement.directoryIdentity, "retirement directory identity");
    assertIdentityShape(operation.retirement.pathIdentity, "retirement path identity");
  }
}

const replacementPath = "managed/existing.txt";
const replacementApplySequence = [
  { phase: "after-barrier-acquired" },
  { phase: "after-journal-created" },
  operationPoint("after-temporary-authorized", replacementPath),
  operationPoint("after-temporary-created-unbound", replacementPath),
  operationPoint("after-temporary-synced", replacementPath),
  operationPoint("after-capture-authorized", replacementPath),
  operationPoint("after-capture-created-unbound", replacementPath),
  operationPoint("after-capture-ready", replacementPath),
  operationPoint("after-preimage-linked-unbound", replacementPath),
  operationPoint("after-preimage-captured", replacementPath),
  operationPoint("after-rollback-temporary-created-unbound", replacementPath),
  operationPoint("after-rollback-temporary-ready", replacementPath),
  operationPoint("after-destination-captured", replacementPath),
  operationPoint("after-destination-retired", replacementPath),
  operationPoint("after-operation-publishing", replacementPath),
  operationPoint("after-postimage-linked", replacementPath),
  operationPoint("after-operation-published", replacementPath),
  { phase: "after-journal-committed" }
];

const temporaryKeys = ["matchedPreimage", "path", "state", "temporaryIdentity"];
const capturedKeys = [
  "captureDirectoryIdentity",
  "capturedPreimageIdentity",
  "matchedPreimage",
  "path",
  "state",
  "temporaryIdentity"
];
const rollbackReadyKeys = [
  "captureDirectoryIdentity",
  "capturedPreimageIdentity",
  "matchedPreimage",
  "path",
  "rollbackTemporaryIdentity",
  "state",
  "temporaryIdentity"
];

const replacementApplyCases = [
  {
    phase: "after-journal-created",
    operation: { keys: ["matchedPreimage", "path", "state"], state: "pending" }
  },
  {
    phase: "after-temporary-authorized",
    operation: { keys: ["matchedPreimage", "path", "state"], state: "temporary-authorized" }
  },
  {
    phase: "after-temporary-synced",
    operation: { keys: temporaryKeys, state: "temporary-ready" }
  },
  {
    phase: "after-capture-authorized",
    operation: { keys: temporaryKeys, state: "capture-authorized" }
  },
  {
    phase: "after-capture-ready",
    operation: {
      keys: [
        "captureDirectoryIdentity",
        "matchedPreimage",
        "path",
        "state",
        "temporaryIdentity"
      ],
      state: "capture-ready"
    }
  },
  {
    phase: "after-preimage-captured",
    operation: { keys: capturedKeys, state: "preimage-captured" }
  },
  {
    phase: "after-rollback-temporary-ready",
    operation: { keys: rollbackReadyKeys, state: "preimage-captured" }
  },
  {
    phase: "after-destination-captured",
    operation: { keys: rollbackReadyKeys, state: "preimage-captured" }
  },
  {
    phase: "after-destination-retired",
    operation: { keys: rollbackReadyKeys, state: "destination-retired" }
  },
  {
    phase: "after-operation-publishing",
    operation: { keys: rollbackReadyKeys, state: "publishing" }
  },
  {
    phase: "after-postimage-linked",
    operation: { keys: rollbackReadyKeys, state: "publishing" }
  },
  {
    phase: "after-operation-published",
    operation: { keys: rollbackReadyKeys, state: "published" }
  },
  {
    envelopeState: "COMMITTED",
    phase: "after-journal-committed",
    operation: { keys: rollbackReadyKeys, state: "published" },
    recoveryOutcome: "applied"
  }
];

for (const characterization of replacementApplyCases) {
  posixTest(`characterizes replacement apply at ${characterization.phase}`, async () => {
    const { plan, root } = await createFixture();
    const terminalIndex = replacementApplySequence.findIndex(
      ({ phase }) => phase === characterization.phase
    );
    const crash = scriptedCrash(
      replacementApplySequence.slice(0, terminalIndex + 1),
      `replacement apply through ${characterization.phase}`
    );
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: root, plan, faultInjector: crash.faultInjector }),
      new RegExp(`characterization-stop:${characterization.phase}`, "u")
    );
    crash.assertConsumed();

    const envelope = await readJournal(root);
    assert.equal(envelope.state, characterization.envelopeState ?? "APPLYING");
    assert.equal(envelope.journal.plan.planDigest, plan.planDigest);
    assertOperationShape(envelope.journal.operations[0], characterization.operation);

    const recovery = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovery.outcome, characterization.recoveryOutcome ?? "rolled-back");
    assert.equal(
      await readFile(join(root, "managed", "existing.txt"), "utf8"),
      recovery.outcome === "applied" ? "new\n" : "old\n"
    );
  });
}

const nestedApplySequence = [
  { phase: "after-barrier-acquired" },
  { phase: "after-journal-created" },
  operationPoint("after-directory-authorized", "nested"),
  operationPoint("after-directory-created-unbound", "nested"),
  operationPoint("after-directory-created", "nested")
];

for (const characterization of [
  {
    authorizedDirectories: ["nested"],
    createdDirectories: [],
    phase: "after-directory-authorized"
  },
  {
    authorizedDirectories: [],
    createdDirectories: ["nested"],
    phase: "after-directory-created"
  }
]) {
  posixTest(`characterizes parent recovery at ${characterization.phase}`, async () => {
    const { plan, root } = await createFixture({ nested: true });
    const terminalIndex = nestedApplySequence.findIndex(
      ({ phase }) => phase === characterization.phase
    );
    const crash = scriptedCrash(
      nestedApplySequence.slice(0, terminalIndex + 1),
      `directory apply through ${characterization.phase}`
    );
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: root, plan, faultInjector: crash.faultInjector }),
      new RegExp(`characterization-stop:${characterization.phase}`, "u")
    );
    crash.assertConsumed();

    const envelope = await readJournal(root);
    assert.deepEqual(envelope.journal.authorizedDirectories, characterization.authorizedDirectories);
    assert.deepEqual(
      envelope.journal.createdDirectories.map(({ path }) => path),
      characterization.createdDirectories
    );
    for (const directory of envelope.journal.createdDirectories) {
      assertIdentityShape(directory.identity, "created directory identity");
    }
    assertOperationShape(envelope.journal.operations[0], {
      keys: ["path", "state"],
      state: "pending"
    });

    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    await assert.rejects(stat(join(root, "nested")), (error) => error?.code === "ENOENT");
  });
}

const replacementRecoverySequence = [
  operationPoint("after-retirement-directory-bound", replacementPath),
  operationPoint("after-retirement-captured", replacementPath),
  operationPoint("after-retirement-unlink-authorized", replacementPath),
  operationPoint("after-destination-retired", replacementPath),
  operationPoint("after-rollback-linked", replacementPath),
  operationPoint("after-rollback-capture-unlinked", replacementPath)
];

const replacementRecoveryCases = [
  {
    phase: "after-retirement-directory-bound",
    operation: {
      keys: [...rollbackReadyKeys, "retirement"].toSorted(),
      retirement: "ready",
      state: "published"
    }
  },
  {
    phase: "after-retirement-captured",
    operation: {
      keys: [...rollbackReadyKeys, "retirement"].toSorted(),
      retirement: "captured",
      state: "published"
    }
  },
  {
    phase: "after-retirement-unlink-authorized",
    operation: {
      keys: [...rollbackReadyKeys, "retirement"].toSorted(),
      retirement: "unlink-authorized",
      state: "published"
    }
  },
  {
    phase: "after-destination-retired",
    operation: { keys: rollbackReadyKeys, state: "published" }
  },
  {
    phase: "after-rollback-linked",
    operation: { keys: rollbackReadyKeys, state: "published" }
  },
  {
    phase: "after-rollback-capture-unlinked",
    operation: { keys: rollbackReadyKeys, state: "rollback-restored" }
  }
];

for (const characterization of replacementRecoveryCases) {
  posixTest(`characterizes replacement recovery at ${characterization.phase}`, async () => {
    const { plan, root } = await createFixture();
    await assert.rejects(applyKnownFileTransaction({
      consumerRoot: root,
      plan,
      faultInjector(point) {
        if (point.phase === "after-operation-published") {
          throw new Error("seed-recovery");
        }
      }
    }), /seed-recovery/u);

    const terminalIndex = replacementRecoverySequence.findIndex(
      ({ phase }) => phase === characterization.phase
    );
    const crash = scriptedCrash(
      replacementRecoverySequence.slice(0, terminalIndex + 1),
      `replacement recovery through ${characterization.phase}`
    );
    await assert.rejects(
      recoverKnownFileTransaction({ consumerRoot: root, faultInjector: crash.faultInjector }),
      new RegExp(`characterization-stop:${characterization.phase}`, "u")
    );
    crash.assertConsumed();

    const envelope = await readJournal(root);
    assert.equal(envelope.state, "APPLYING");
    assertOperationShape(envelope.journal.operations[0], characterization.operation);

    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
    assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
  });
}
