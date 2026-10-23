import assert from "node:assert/strict";
import test from "node:test";
import { persistedTree, assertManualOnly } from "./support/transaction-recovery-snapshot.ts";
import { registerRecoveryCases } from "./support/transaction-recovery-cases.ts";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  assertKnownFileTransactionEnvelope,
  canonicalJson,
  compileKnownFileTransactionPlan,
  compileRepositoryMutationEnvelope,
  inspectKnownFileTransactionBarrier,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
} from "../packages/repository-mutation/dist/index.js";
import {
  applyKnownFileTransaction,
  recoverKnownFileTransaction,
} from "../packages/repository-mutation/dist/qualification/index.js";
import {
  fixture,
  plan,
  posixTest,
  replacementPlan,
  temporaryDirectory,
} from "./support/known-file-transaction-node-fixtures.mjs";
import {
  assertKnownFileSchemaIdentity,
  readHistoricalKnownFileFixture,
} from "./support/known-file-transaction-schema-fixtures.mjs";
registerRecoveryCases();

test("persisted snapshots retain directory identities without opening directories", async (context) => {
  const root = await fixture(context);
  const entries = await persistedTree(root, false, async (path, flags) => {
    assert.ok((await stat(path)).isFile(), "Windows cannot open directories as files.");
    return open(path, flags);
  });
  for (const entry of entries) {
    const metadata = await stat(join(root, entry.path), { bigint: true });
    for (const field of ["dev", "ino", "birthtimeNs", "mode", "nlink"]) {
      assert.equal(entry[field], metadata[field]);
    }
  }
  assert.equal(entries.find(({ path }) => path === "managed").bytes, undefined);
  assert.deepEqual(entries.find(({ bytes }) => bytes !== undefined).bytes, Buffer.from("old\n"));
});

posixTest(
  "persisted file metadata and bytes survive pathname replacement on one handle",
  async (context) => {
    const root = await fixture(context);
    const destination = join(root, "managed", "existing.txt");
    const original = await stat(destination, { bigint: true });
    const entries = await persistedTree(root, false, async (path, flags) => {
      const handle = await open(path, flags);
      return {
        async stat(options) {
          const metadata = await handle.stat(options);
          await rename(path, `${path}.original`);
          await writeFile(path, "replacement\n");
          return metadata;
        },
        readFile: () => handle.readFile(),
        close: () => handle.close(),
      };
    });
    const entry = entries.find(({ path }) => path === join("managed", "existing.txt"));
    assert.equal(entry.ino, original.ino);
    assert.deepEqual(entry.bytes, Buffer.from("old\n"));
    assert.equal(await readFile(destination, "utf8"), "replacement\n");
  },
);

test("persisted snapshots close file handles when metadata or byte reads fail", async (context) => {
  const root = await fixture(context);
  for (const failingOperation of ["stat", "readFile"]) {
    const failure = new Error(`snapshot ${failingOperation} failure`);
    let closed = false;
    await assert.rejects(
      persistedTree(root, false, async (path, flags) => {
        const handle = await open(path, flags);
        return {
          stat: (options) =>
            failingOperation === "stat" ? Promise.reject(failure) : handle.stat(options),
          readFile: () => Promise.reject(failure),
          async close() {
            await handle.close();
            closed = true;
          },
        };
      }),
      (error) => error === failure,
    );
    assert.equal(closed, true);
  }
});

posixTest(
  "persisted snapshots preserve followed symlink and hardlink evidence",
  async (context) => {
    const root = await fixture(context);
    const destination = join(root, "managed", "existing.txt");
    await link(destination, join(root, "hardlink"));
    await symlink(destination, join(root, "symlink"));
    await symlink(join(root, "managed"), join(root, "directory-link"), "dir");
    const entries = await persistedTree(root, false);
    const original = entries.find(({ path }) => path === join("managed", "existing.txt"));
    for (const path of ["hardlink", "symlink"]) {
      assert.deepEqual(
        entries.find((entry) => entry.path === path),
        { ...original, path },
      );
    }
    assert.equal(original.nlink, 2n);
    const directory = entries.find(({ path }) => path === "managed");
    assert.deepEqual(
      entries.find(({ path }) => path === "directory-link"),
      { ...directory, path: "directory-link" },
    );
  },
);

for (const [name, destination] of [
  ["after-operation-published", "managed/result.txt"],
  ["after-journal-committed", "managed/result.txt"],
  ["impossible-applying-envelope", "managed"],
]) {
  posixTest(
    `preserves native Foundation 0.21.0 ${name} bytes and partial output`,
    async (context) => {
      const root = await temporaryDirectory(context, "mutation-frozen-foundation-");
      const historical = await readHistoricalKnownFileFixture(name);
      assert.equal(historical.value.schemaVersion, 5);
      await assertKnownFileSchemaIdentity("plan", historical.value.journal.plan, "historical");
      assert.throws(() => assertKnownFileTransactionEnvelope(historical.value), /envelope/u);
      await mkdir(join(root, ".agent-teams-local"));
      if (destination.includes("/")) {
        await mkdir(join(root, "managed"));
      }
      await writeFile(join(root, destination), "created\n", { mode: 0o644 });
      const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
      await writeFile(journalPath, historical.bytes);
      // Recreated physical identities confer no recovery authority. Only the
      // native exact artifact can assess a historical journal; impossible Plans
      // remain manual even when partial published output is present.
      await assertManualOnly(root, /envelope/u);
      assert.deepEqual(await readFile(journalPath), historical.bytes);
      assert.equal(await readFile(join(root, destination), "utf8"), "created\n");
      assert.deepEqual((await readHistoricalKnownFileFixture(name)).bytes, historical.bytes);
    },
  );
}

posixTest(
  "rejects a base impossible Plan before journal or filesystem effects",
  async (context) => {
    const root = await fixture(context);
    const envelope = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/repository-mutation-known-file/base-impossible-applying-envelope.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const before = await persistedTree(root, false);
    const operations = envelope.payload.plan.operations;
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      for (const ancestor of ["managed", "MANAGED"]) {
        await assert.rejects(
          applyKnownFileTransaction({
            consumerRoot: root,
            plan: {
              ...envelope.payload.plan,
              operations: order.map((index) =>
                index === 0 ? { ...operations[index], path: ancestor } : operations[index],
              ),
            },
          }),
          /ancestor and descendant/u,
        );
        assert.deepEqual(await persistedTree(root, false), before);
      }
    }
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  },
);

for (const [label, fixtureName] of [
  ["impossible historical", "base-impossible-applying-envelope.json"],
  ["foreign exact-version", "base-valid-applying-envelope.json"],
]) {
  posixTest(`preserves ${label} journal bytes as manual-only evidence`, async (context) => {
    const root = await fixture(context);
    const state = join(root, ".agent-teams-local");
    const path = join(state, "scaffolding-transaction.json");
    const source = await readFile(
      new URL(`./fixtures/repository-mutation-known-file/${fixtureName}`, import.meta.url),
    );
    await mkdir(state);
    await writeFile(path, source);
    const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
    assert.deepEqual(inspection, {
      state: "recovery-required",
      code: "KNOWN_FILE_RECOVERY_REQUIRED",
      recoverableByInstalledBuild: false,
      message:
        "Unknown, legacy, corrupt, or ambiguous common transaction evidence must be recovered by its exact owner artifact.",
    });
    assert.deepEqual(await readFile(path), source);
    await assertManualOnly(root, /exact owner and kernel/u);
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  });
}

posixTest("preserves unknown journal bytes as manual-only evidence", async (context) => {
  const root = await fixture(context);
  const state = join(root, ".agent-teams-local");
  const path = join(state, "scaffolding-transaction.json");
  const source = Buffer.from('{"schemaVersion":999,"unknown":true}\n');
  await mkdir(state);
  await writeFile(path, source);
  const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(inspection.state, "recovery-required");
  assert.equal(inspection.recoverableByInstalledBuild, false);
  assert.deepEqual(await readFile(path), source);
  await assertManualOnly(root, /envelope|schemaVersion/u);
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

posixTest(
  "an exact installed identity cannot authorize an impossible historical payload",
  async (context) => {
    const root = await fixture(context);
    const original = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/repository-mutation-known-file/base-impossible-applying-envelope.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const artifact = {
      name: "@agent-teams/repository-mutation",
      version: await installedRepositoryMutationVersion(),
      buildIdentity: await installedRepositoryMutationBuildIdentity(),
    };
    // Bind the immutable old payload through the generic envelope compiler, so
    // the test reaches Plan admission instead of stopping at artifact mismatch.
    const envelope = compileRepositoryMutationEnvelope({
      operationKind: original.operationKind,
      recoveryHandler: original.recoveryHandler,
      ownerArtifact: artifact,
      kernelArtifact: artifact,
      adapterContractVersion: original.adapterContractVersion,
      payloadKind: original.payloadKind,
      state: original.state,
      payload: original.payload,
    });
    assert.throws(() => assertKnownFileTransactionEnvelope(envelope), /ancestor and descendant/u);
    await mkdir(join(root, ".agent-teams-local"));
    await writeFile(
      join(root, ".agent-teams-local", "scaffolding-transaction.json"),
      `${canonicalJson(envelope)}\n`,
    );
    await assertManualOnly(root, /ancestor and descendant/u);
  },
);

for (const kind of [
  "unknown-handler",
  "unknown-payload",
  "impossible-lifecycle",
  "corrupt-digest",
  "legacy-v2",
  "unknown-envelope-field",
  "unknown-plan-field",
  "unknown-plan-version",
]) {
  posixTest(
    `preserves ${kind} journal and published bytes when recovery is attempted`,
    async (context) => {
      const root = await fixture(context);
      await assert.rejects(
        applyKnownFileTransaction({
          consumerRoot: root,
          plan: replacementPlan(),
          faultInjector(point) {
            if (point.phase === "after-operation-published") {
              throw new Error("seed-evidence");
            }
          },
        }),
        /seed-evidence/u,
      );
      const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
      const envelope = JSON.parse(await readFile(journalPath, "utf8"));
      const body = {
        operationKind: envelope.operationKind,
        recoveryHandler: envelope.recoveryHandler,
        ownerArtifact: envelope.ownerArtifact,
        kernelArtifact: envelope.kernelArtifact,
        adapterContractVersion: envelope.adapterContractVersion,
        payloadKind: envelope.payloadKind,
        state: envelope.state,
        payload: envelope.payload,
      };
      if (kind === "unknown-handler") {
        body.recoveryHandler = { id: "future-handler", contractVersion: 99 };
      }
      if (kind === "unknown-payload") {
        body.payloadKind = "future-journal/v2";
      }
      if (kind === "impossible-lifecycle") {
        body.payload.operations[0].state = "pending";
      }
      if (kind === "unknown-plan-field") {
        body.payload.plan.unknown = true;
      }
      if (kind === "unknown-plan-version") {
        body.payload.plan.schemaVersion = 2;
      }
      const altered = { ...compileRepositoryMutationEnvelope(body) };
      if (kind === "corrupt-digest") {
        altered.envelopeDigest = `sha256:${"0".repeat(64)}`;
      }
      if (kind === "legacy-v2") {
        altered.schemaVersion = 2;
      }
      if (kind === "unknown-envelope-field") {
        altered.unknown = true;
      }
      await writeFile(journalPath, `${canonicalJson(altered)}\n`);
      await assertManualOnly(root, /envelope|journal|schemaVersion|Plan/u);
      assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
    },
  );
}

test("Windows refusal precedes root observation for both public and qualification APIs (branch emulation)", async (context) => {
  const root = await fixture(context);
  const before = await persistedTree(root, false);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import * as api from ${JSON.stringify(new URL("../packages/repository-mutation/dist/index.js", import.meta.url).href)};
    import * as qualification from ${JSON.stringify(new URL("../packages/repository-mutation/dist/qualification/index.js", import.meta.url).href)};
    Object.defineProperty(process, "platform", { value: "win32" });
    const plan = api.compileKnownFileTransactionPlan({ operations: [{ path: "new.txt",
      precondition: { state: "absent" }, postimage: { bytes: Buffer.from("new") } }] });
    for (const caller of [api, qualification]) {
      for (const consumerRoot of [process.argv[1], process.argv[1] + "/missing"]) {
        for (const action of ["applyKnownFileTransaction", "recoverKnownFileTransaction"]) {
          const options = action === "applyKnownFileTransaction" ? { consumerRoot, plan } : { consumerRoot };
          await assert.rejects(caller[action](options), error =>
            error.code === "KNOWN_FILE_APPLY_UNSUPPORTED" && /not qualified on Windows/.test(error.message));
        }
      }
    }
  `,
      root,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, "");
  assert.deepEqual(await persistedTree(root, false), before);
});

for (const phase of ["after-operation-publishing", "after-operation-published"]) {
  posixTest(`recovers an interrupted replacement at ${phase}`, async (context) => {
    const root = await fixture(context);
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: compileKnownFileTransactionPlan({
          operations: [plan().operations[0]].map((operation) => ({
            path: operation.path,
            precondition: {
              state: "known-file",
              acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
                bytes: Buffer.from(image.contentBase64, "base64"),
                mode: image.mode,
              })),
            },
            postimage: {
              bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
              mode: operation.postimage.mode,
            },
          })),
        }),
        faultInjector(point) {
          if (point.phase === phase) {
            throw new Error("simulated crash");
          }
        },
      }),
      /simulated crash/u,
    );
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(recovered.operations[0].outcome, "rolled-back-to-preimage");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
  });
}

posixTest("preserves an unbound rollback temporary after its creation window", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({
    operations: [
      {
        path: "managed/existing.txt",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }],
        },
        postimage: { bytes: Buffer.from("new\n"), mode: 0o640 },
      },
    ],
  });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === "after-rollback-temporary-created-unbound") {
          throw new Error("simulated crash");
        }
      },
    }),
    /simulated crash/u,
  );
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT",
  );
  assert.equal(
    await readFile(join(root, "managed", ".existing.txt.agent-teams.rollback.0.tmp"), "utf8"),
    "old\n",
  );
});

for (const phase of [
  "after-destination-retired",
  "after-rollback-linked",
  "after-rollback-capture-unlinked",
]) {
  posixTest(`resumes rollback after a crash at ${phase}`, async (context) => {
    const root = await fixture(context);
    const single = compileKnownFileTransactionPlan({
      operations: [
        {
          path: "managed/existing.txt",
          precondition: {
            state: "known-file",
            acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }],
          },
          postimage: { bytes: Buffer.from("new\n"), mode: 0o640 },
        },
      ],
    });
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: single,
        faultInjector(point) {
          if (point.phase === "after-operation-published") {
            throw new Error("apply crash");
          }
        },
      }),
      /apply crash/u,
    );
    await assert.rejects(
      recoverKnownFileTransaction({
        consumerRoot: root,
        faultInjector(point) {
          if (point.phase === phase) {
            throw new Error("recovery crash");
          }
        },
      }),
      /recovery crash/u,
    );
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
    assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
    assert.equal(
      (await applyKnownFileTransaction({ consumerRoot: root, plan: single })).outcome,
      "applied",
    );
  });
}

posixTest("preserves a destination that appears before rollback publication", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({
    operations: [plan().operations[0]].map((operation) => ({
      path: operation.path,
      precondition: {
        state: "known-file",
        acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
          bytes: Buffer.from(image.contentBase64, "base64"),
          mode: image.mode,
        })),
      },
      postimage: {
        bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
        mode: operation.postimage.mode,
      },
    })),
  });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === "after-operation-published") {
          throw new Error("apply crash");
        }
      },
    }),
    /apply crash/u,
  );
  await assert.rejects(
    recoverKnownFileTransaction({
      consumerRoot: root,
      async faultInjector(point) {
        if (point.phase === "after-destination-retired") {
          await writeFile(join(root, "managed", "existing.txt"), "foreign\n", { mode: 0o640 });
        }
      },
    }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT",
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "foreign\n");
});

posixTest(
  "preserves an exact-content foreign temporary when its identity changed",
  async (context) => {
    const root = await fixture(context);
    const single = compileKnownFileTransactionPlan({
      operations: [plan().operations[0]].map((operation) => ({
        path: operation.path,
        precondition: {
          state: "known-file",
          acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
            bytes: Buffer.from(image.contentBase64, "base64"),
            mode: image.mode,
          })),
        },
        postimage: {
          bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
          mode: operation.postimage.mode,
        },
      })),
    });
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: single,
        faultInjector(point) {
          if (point.phase === "after-temporary-synced") {
            throw new Error("simulated crash");
          }
        },
      }),
      /simulated crash/u,
    );
    const files = await readdir(join(root, "managed"));
    const temporary = files.find(
      (name) => name.startsWith(".existing.txt.agent-teams.") && name.endsWith(".tmp"),
    );
    assert.ok(temporary);
    const temporaryPath = join(root, "managed", temporary);
    await rename(temporaryPath, `${temporaryPath}.original`);
    await writeFile(temporaryPath, "new\n", { mode: 0o640 });
    await assert.rejects(
      recoverKnownFileTransaction({ consumerRoot: root }),
      (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT",
    );
    assert.equal(await readFile(temporaryPath, "utf8"), "new\n");
  },
);

posixTest("rejects hard-linked destinations before mutation", async (context) => {
  const root = await fixture(context);
  await link(join(root, "managed", "existing.txt"), join(root, "managed", "existing-hardlink.txt"));
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
    (error) => error?.code === "KNOWN_FILE_HARDLINK",
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

posixTest(
  "finishes retirement of a committed transaction without rolling it back",
  async (context) => {
    const root = await fixture(context);
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: plan(),
        faultInjector(point) {
          if (point.phase === "after-journal-committed") {
            throw new Error("simulated crash");
          }
        },
      }),
      /simulated crash/u,
    );
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "applied");
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(root, "managed", "new.txt"), "utf8"), "created\n");
  },
);

posixTest("committed recovery verifies unchanged guard operations too", async (context) => {
  const root = await fixture(context);
  await writeFile(join(root, "managed", "new.txt"), "created\n", { mode: 0o644 });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: plan(),
      faultInjector(point) {
        if (point.phase === "after-journal-committed") {
          throw new Error("commit crash");
        }
      },
    }),
    /commit crash/u,
  );
  await writeFile(join(root, "managed", "new.txt"), "guard drift\n", { mode: 0o644 });
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_COMMITTED_DRIFT",
  );
  assert.ok(await stat(join(root, ".agent-teams-local", "scaffolding-transaction.json")));
});

posixTest("never rolls back an exact third-party postimage replacement", async (context) => {
  const root = await fixture(context);
  const single = compileKnownFileTransactionPlan({
    operations: [
      {
        path: "managed/existing.txt",
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }],
        },
        postimage: { bytes: Buffer.from("new\n"), mode: 0o640 },
      },
    ],
  });
  await assert.rejects(
    applyKnownFileTransaction({
      consumerRoot: root,
      plan: single,
      faultInjector(point) {
        if (point.phase === "after-operation-published") {
          throw new Error("simulated crash");
        }
      },
    }),
    /simulated crash/u,
  );
  const replacement = join(root, "managed", "replacement.tmp");
  await writeFile(replacement, "new\n", { mode: 0o640 });
  await rename(replacement, join(root, "managed", "existing.txt"));
  await assert.rejects(
    recoverKnownFileTransaction({ consumerRoot: root }),
    (error) => error?.code === "KNOWN_FILE_RECOVERY_CONFLICT",
  );
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
  assert.ok(await stat(join(root, ".agent-teams-local", "scaffolding-transaction.json")));
});

posixTest(
  "recovers from the canonical journal while preserving a torn transition candidate",
  async (context) => {
    const root = await fixture(context);
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: plan(),
        faultInjector(point) {
          if (point.phase === "after-operation-published" && point.operationIndex === 0) {
            throw new Error("apply crash");
          }
        },
      }),
      /apply crash/u,
    );
    const torn = join(root, ".agent-teams-local", "scaffolding-transaction.json.known-file.tmp");
    await writeFile(torn, '{"schemaVersion":5', "utf8");
    const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
    assert.equal(recovered.outcome, "rolled-back");
    await assert.rejects(readFile(torn, "utf8"), (error) => error?.code === "ENOENT");
    assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
    assert.equal(
      (await applyKnownFileTransaction({ consumerRoot: root, plan: plan() })).outcome,
      "applied",
    );
  },
);

posixTest("canonical-absent torn journal candidate remains manual evidence", async (context) => {
  const root = await fixture(context);
  const state = join(root, ".agent-teams-local");
  await mkdir(state);
  const torn = join(state, "scaffolding-transaction.json.known-file.tmp");
  await writeFile(torn, '{"schemaVersion":5', "utf8");
  const barrier = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
  assert.equal(barrier.state, "recovery-required");
  assert.equal(barrier.recoverableByInstalledBuild, false);
  await assert.rejects(recoverKnownFileTransaction({ consumerRoot: root }));
  assert.equal(await readFile(torn, "utf8"), '{"schemaVersion":5');
  assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
});

for (const [name, evidence] of [
  ["corrupt v5", { schemaVersion: 5 }],
  ["invalid schema version", { operationKind: "known-file-transaction" }],
]) {
  posixTest(`classifies ${name} transaction evidence for manual recovery`, async (context) => {
    const root = await fixture(context);
    const state = join(root, ".agent-teams-local");
    await mkdir(state);
    await writeFile(
      join(state, "scaffolding-transaction.json"),
      `${JSON.stringify(evidence)}\n`,
      "utf8",
    );
    const barrier = await inspectKnownFileTransactionBarrier({ consumerRoot: root });
    assert.equal(barrier.state, "recovery-required");
    assert.equal(barrier.recoverableByInstalledBuild, false);
  });
}
