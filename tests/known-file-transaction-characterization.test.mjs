import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalKnownFileTransactionReceipt,
  compileKnownFileTransactionPlan
} from "../packages/repository-mutation/dist/index.js";
import { applyKnownFileTransaction, recoverKnownFileTransaction } from "../packages/repository-mutation/dist/qualification/index.js";
import { canonicalJson } from "../packages/engineering-foundation/dist/canonical-json.js";
import { classifyKnownFileRecoveryTransition } from "../packages/repository-mutation/dist/repository-mutation/application/policies/classify-known-file-recovery-transition.js";
import { compileKnownFileTransactionEnvelope } from "../packages/repository-mutation/dist/repository-mutation/application/policies/known-file-transaction-envelope.js";
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

async function createFixture(context, { nested = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "foundation-known-file-characterization-"));
  context.after(() => rm(root, { force: true, recursive: true }));
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
  const serialized = await readFile(journalPath(root), "utf8");
  const envelope = JSON.parse(serialized);
  assert.equal(
    serialized,
    `${canonicalJson(envelope)}\n`,
    "journal bytes must remain canonical with one trailing newline"
  );
  assert.deepEqual(Object.keys(envelope).toSorted(), [
    "adapterContractVersion",
    "envelopeDigest",
    "format",
    "kernelArtifact",
    "operationKind",
    "ownerArtifact",
    "payload",
    "payloadDigest",
    "payloadKind",
    "recoveryHandler",
    "schemaVersion",
    "state"
  ]);
  assert.deepEqual(Object.keys(envelope.payload).toSorted(), [
    "authorizedDirectories",
    "createdDirectories",
    "operations",
    "plan",
    "schemaVersion"
  ]);
  assert.deepEqual(
    compileKnownFileTransactionEnvelope({
      ownerArtifact: envelope.ownerArtifact,
      kernelArtifact: envelope.kernelArtifact,
      journal: envelope.payload,
      state: envelope.state
    }),
    envelope,
    "journal digests and canonical envelope body must round-trip"
  );
  return envelope;
}

posixTest("keeps applied receipt bytes canonical and deterministic", async (context) => {
  const first = await createFixture(context);
  const second = await createFixture(context);
  const firstReceipt = await applyKnownFileTransaction({
    consumerRoot: first.root,
    plan: first.plan
  });
  const secondReceipt = await applyKnownFileTransaction({
    consumerRoot: second.root,
    plan: second.plan
  });
  const serialized = canonicalKnownFileTransactionReceipt(firstReceipt);
  assert.equal(serialized, `${canonicalJson(firstReceipt)}\n`);
  assert.equal(serialized, canonicalKnownFileTransactionReceipt(secondReceipt));
});

function classifyStoredEnvelope(envelope) {
  return classifyKnownFileRecoveryTransition({
    envelope,
    installedBuild: {
      ownerArtifact: envelope.ownerArtifact,
      kernelArtifact: envelope.kernelArtifact
    }
  });
}

test("goldens top-level known-file v1 recovery transitions without changing envelope bytes", () => {
  const plan = createPlan();
  const journal = {
    schemaVersion: 1,
    plan,
    operations: [{ path: plan.operations[0].path, state: "pending", matchedPreimage: 0 }],
    authorizedDirectories: [],
    createdDirectories: []
  };
  const artifact = {
    name: "@agent-teams/repository-mutation",
    version: "0.17.0",
    buildIdentity: `sha256:${"1".repeat(64)}`
  };
  const applying = compileKnownFileTransactionEnvelope({
    ownerArtifact: artifact,
    kernelArtifact: artifact,
    journal,
    state: "APPLYING"
  });
  const committed = compileKnownFileTransactionEnvelope({
    ownerArtifact: artifact,
    kernelArtifact: artifact,
    journal,
    state: "COMMITTED"
  });
  const cases = [
    {
      label: "exact APPLYING journal rolls back",
      envelope: applying,
      installedBuild: { ownerArtifact: artifact, kernelArtifact: artifact },
      expected: { action: "rollback-applying" }
    },
    {
      label: "exact COMMITTED journal resumes terminal cleanup",
      envelope: committed,
      installedBuild: { ownerArtifact: artifact, kernelArtifact: artifact },
      expected: { action: "resume-committed-cleanup" }
    },
    {
      label: "different version rejects before APPLYING rollback",
      envelope: applying,
      installedBuild: {
        ownerArtifact: { ...artifact, version: "0.17.1" },
        kernelArtifact: artifact
      },
      expected: {
        action: "reject",
        code: "KNOWN_FILE_EXACT_BUILD_REQUIRED",
        message: "The exact owner and kernel artifacts that created this journal must recover it."
      }
    },
    {
      label: "different build rejects before COMMITTED cleanup",
      envelope: committed,
      installedBuild: {
        ownerArtifact: artifact,
        kernelArtifact: { ...artifact, buildIdentity: `sha256:${"2".repeat(64)}` }
      },
      expected: {
        action: "reject",
        code: "KNOWN_FILE_EXACT_BUILD_REQUIRED",
        message: "The exact owner and kernel artifacts that created this journal must recover it."
      }
    }
  ];

  for (const characterization of cases) {
    const before = JSON.stringify(characterization.envelope);
    assert.deepEqual(classifyKnownFileRecoveryTransition({
      envelope: characterization.envelope,
      installedBuild: characterization.installedBuild
    }), characterization.expected, characterization.label);
    assert.equal(JSON.stringify(characterization.envelope), before, characterization.label);
  }
});

test("keeps the top-level recovery classifier free of Node and process adapters", async () => {
  const source = await readFile(new URL(
    "../packages/repository-mutation/src/repository-mutation/application/policies/classify-known-file-recovery-transition.ts",
    import.meta.url
  ), "utf8");
  assert.doesNotMatch(source, /(?:node:|adapters\/node|\bprocess\b)/u);
});

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

async function assertDestinationState(root, expected) {
  const destination = join(root, "managed", "existing.txt");
  if (expected === "absent") {
    await assert.rejects(stat(destination), (error) => error?.code === "ENOENT");
    return;
  }
  assert.equal(await readFile(destination, "utf8"), `${expected}\n`);
}

async function assertCaptureEntries(root, expected) {
  const managed = join(root, "managed");
  const captureDirectories = (await readdir(managed)).filter((name) =>
    name.includes(".agent-teams.capture.")
  );
  assert.equal(captureDirectories.length, 1);
  assert.deepEqual(
    (await readdir(join(managed, captureDirectories[0]))).toSorted(),
    expected
  );
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
    destination: "old",
    phase: "after-journal-created",
    operation: { keys: ["matchedPreimage", "path", "state"], state: "pending" }
  },
  {
    destination: "old",
    phase: "after-temporary-authorized",
    operation: { keys: ["matchedPreimage", "path", "state"], state: "temporary-authorized" }
  },
  {
    destination: "old",
    phase: "after-temporary-synced",
    operation: { keys: temporaryKeys, state: "temporary-ready" }
  },
  {
    destination: "old",
    phase: "after-capture-authorized",
    operation: { keys: temporaryKeys, state: "capture-authorized" }
  },
  {
    destination: "old",
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
    destination: "old",
    phase: "after-preimage-captured",
    operation: { keys: capturedKeys, state: "preimage-captured" }
  },
  {
    destination: "old",
    phase: "after-rollback-temporary-ready",
    operation: { keys: rollbackReadyKeys, state: "preimage-captured" }
  },
  {
    captureEntries: ["preimage", "retired"],
    destination: "absent",
    phase: "after-destination-captured",
    operation: { keys: rollbackReadyKeys, state: "preimage-captured" }
  },
  {
    captureEntries: ["preimage"],
    destination: "absent",
    phase: "after-destination-retired",
    operation: { keys: rollbackReadyKeys, state: "destination-retired" }
  },
  {
    destination: "absent",
    phase: "after-operation-publishing",
    operation: { keys: rollbackReadyKeys, state: "publishing" }
  },
  {
    destination: "new",
    phase: "after-postimage-linked",
    operation: { keys: rollbackReadyKeys, state: "publishing" }
  },
  {
    destination: "new",
    phase: "after-operation-published",
    operation: { keys: rollbackReadyKeys, state: "published" }
  },
  {
    destination: "new",
    envelopeState: "COMMITTED",
    phase: "after-journal-committed",
    operation: { keys: rollbackReadyKeys, state: "published" },
    recoveryOutcome: "applied"
  }
];

for (const characterization of replacementApplyCases) {
  posixTest(`characterizes replacement apply at ${characterization.phase}`, async (context) => {
    const { plan, root } = await createFixture(context);
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
    assert.deepEqual(classifyStoredEnvelope(envelope), characterization.envelopeState === "COMMITTED"
      ? { action: "resume-committed-cleanup" }
      : { action: "rollback-applying" });
    assert.equal(envelope.payload.plan.planDigest, plan.planDigest);
    assertOperationShape(envelope.payload.operations[0], characterization.operation);
    await assertDestinationState(root, characterization.destination);
    if (characterization.captureEntries !== undefined) {
      await assertCaptureEntries(root, characterization.captureEntries);
    }

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
  posixTest(`characterizes parent recovery at ${characterization.phase}`, async (context) => {
    const { plan, root } = await createFixture(context, { nested: true });
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
    assert.deepEqual(envelope.payload.authorizedDirectories, characterization.authorizedDirectories);
    assert.deepEqual(
      envelope.payload.createdDirectories.map(({ path }) => path),
      characterization.createdDirectories
    );
    for (const directory of envelope.payload.createdDirectories) {
      assertIdentityShape(directory.identity, "created directory identity");
    }
    assertOperationShape(envelope.payload.operations[0], {
      keys: ["path", "state"],
      state: "pending"
    });

    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    await assert.rejects(stat(join(root, "nested")), (error) => error?.code === "ENOENT");
  });
}

posixTest("preserves a directory that appears after parent authorization", async (context) => {
  const { plan, root } = await createFixture(context, { nested: true });
  const terminalIndex = nestedApplySequence.findIndex(
    ({ phase }) => phase === "after-directory-authorized"
  );
  const crash = scriptedCrash(
    nestedApplySequence.slice(0, terminalIndex + 1),
    "directory apply through after-directory-authorized"
  );
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan, faultInjector: crash.faultInjector }),
    /characterization-stop:after-directory-authorized/u
  );
  crash.assertConsumed();

  await mkdir(join(root, "nested"));
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT"
  );
  assert.equal((await stat(join(root, "nested"))).isDirectory(), true);
});

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
    destination: "new",
    phase: "after-retirement-directory-bound",
    operation: {
      keys: [...rollbackReadyKeys, "retirement"].toSorted(),
      retirement: "ready",
      state: "published"
    }
  },
  {
    destination: "absent",
    phase: "after-retirement-captured",
    operation: {
      keys: [...rollbackReadyKeys, "retirement"].toSorted(),
      retirement: "captured",
      state: "published"
    }
  },
  {
    destination: "absent",
    phase: "after-retirement-unlink-authorized",
    operation: {
      keys: [...rollbackReadyKeys, "retirement"].toSorted(),
      retirement: "unlink-authorized",
      state: "published"
    }
  },
  {
    destination: "absent",
    phase: "after-destination-retired",
    operation: { keys: rollbackReadyKeys, state: "published" }
  },
  {
    destination: "old",
    phase: "after-rollback-linked",
    operation: { keys: rollbackReadyKeys, state: "published" }
  },
  {
    destination: "old",
    phase: "after-rollback-capture-unlinked",
    operation: { keys: rollbackReadyKeys, state: "rollback-restored" }
  }
];

for (const characterization of replacementRecoveryCases) {
  posixTest(`characterizes replacement recovery at ${characterization.phase}`, async (context) => {
    const { plan, root } = await createFixture(context);
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
    assert.deepEqual(classifyStoredEnvelope(envelope), { action: "rollback-applying" });
    assertOperationShape(envelope.payload.operations[0], characterization.operation);
    await assertDestinationState(root, characterization.destination);

    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
    assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
  });
}
