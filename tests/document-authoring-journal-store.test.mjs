import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../packages/engineering-foundation/dist/canonical-json.js";
import { createDocumentTransactionEnvelope } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";
import { NodeDocumentJournalStore } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-journal-store-private.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url)
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

async function envelope(destinationState = "pending") {
  const body = {
    schemaVersion: 3,
    operationKind: "document-authoring",
    recoveryHandler: {
      id: "foundation.document-authoring",
      contractVersion: 2
    },
    foundation: {
      version: fixture.plan.compiler.version,
      buildIdentity: fixture.plan.compiler.buildIdentity
    },
    adapterContractVersion: 1,
    payloadKind: "document-authoring-journal/v2",
    journal: {
      schemaVersion: 2,
      plan: fixture.plan,
      destination: {
        path: fixture.plan.destination,
        state: destinationState
      }
    },
    state: "PREPARED"
  };
  return await createDocumentTransactionEnvelope(body);
}

async function fixtureStore(options) {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-journal-"));
  const state = join(root, ".agent-teams-local");
  await mkdir(state);
  const path = join(state, "scaffolding-transaction.json");
  return {
    path,
    root,
    state,
    store: new NodeDocumentJournalStore(path, options)
  };
}

async function withFixture(run, options) {
  const value = await fixtureStore(options);
  try {
    await run(value);
  } finally {
    await rm(value.root, { force: true, recursive: true });
  }
}

test("creates, reads, replaces, and removes canonical document journal evidence", async () => {
  await withFixture(async ({ path, store }) => {
    const first = await envelope();
    const firstIdentity = await store.create(first);
    assert.notEqual(firstIdentity.dev, "0");
    assert.notEqual(firstIdentity.ino, "0");
    assert.notEqual(firstIdentity.birthtimeNs, "0");
    assert.deepEqual((await store.read()).envelope, first);
    assert.equal(
      await readFile(path, "utf8"),
      `${canonicalJson(first)}\n`
    );

    const second = structuredClone(first);
    second.journal.destination.state = "preexisting";
    const replacement = await createDocumentTransactionEnvelope({
      ...second,
      state: "PREPARED"
    });
    const secondIdentity = await store.replace({
      expectedIdentity: firstIdentity,
      envelope: replacement
    });
    assert.notEqual(secondIdentity.ino, firstIdentity.ino);
    assert.deepEqual((await store.read()).envelope, replacement);

    await store.remove(secondIdentity);
    assert.equal(await store.read(), undefined);
    assert.deepEqual(await readdir(join(path, "..")), []);
  });
});

test("reconciles create, replace, and remove only after a fresh directory sync", async () => {
  await withFixture(async ({ path }) => {
    let operation = "create";
    let failedFinalSync = false;
    let reconciliationSyncs = 0;
    const store = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (point.phase === "before-reconciliation-directory-sync") {
          reconciliationSyncs += 1;
        }
        if (point.phase === "before-final-directory-sync" &&
          point.operation === operation && !failedFinalSync) {
          failedFinalSync = true;
          throw new Error(`injected ${operation} final directory sync failure`);
        }
      }
    });

    const first = await envelope();
    await assert.rejects(store.create(first), /create final directory sync/u);
    const created = await store.stabilizeForReconciliation();
    assert.deepEqual(created.envelope, first);

    operation = "replace";
    failedFinalSync = false;
    const replacementBody = structuredClone(first);
    replacementBody.journal.destination.state = "preexisting";
    const replacement = await createDocumentTransactionEnvelope(replacementBody);
    await assert.rejects(
      store.replace({ expectedIdentity: created.identity, envelope: replacement }),
      /replace final directory sync/u
    );
    const replaced = await store.stabilizeForReconciliation();
    assert.deepEqual(replaced.envelope, replacement);

    operation = "remove";
    failedFinalSync = false;
    await assert.rejects(store.remove(replaced.identity), /remove final directory sync/u);
    assert.equal(await store.stabilizeForReconciliation(), undefined);
    assert.equal(reconciliationSyncs, 3);
  });
});

test("a failed reconciliation sync never acknowledges an apparently committed journal", async () => {
  await withFixture(async ({ path }) => {
    let finalFailed = false;
    const store = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (point.phase === "before-final-directory-sync" && !finalFailed) {
          finalFailed = true;
          throw new Error("injected final directory sync failure");
        }
        if (point.phase === "before-reconciliation-directory-sync") {
          throw new Error("injected reconciliation directory sync failure");
        }
      }
    });
    await assert.rejects(store.create(await envelope()), /final directory sync/u);
    await assert.rejects(
      store.stabilizeForReconciliation(),
      /reconciliation directory sync/u
    );
  });
});

test("never overwrites a foreign canonical slot and preserves its candidate", async () => {
  await withFixture(async ({ path, state, store }) => {
    await writeFile(path, "foreign evidence\n", { flag: "wx", mode: 0o600 });
    await assert.rejects(
      store.create(await envelope()),
      /slot is occupied/u
    );
    assert.equal(await readFile(path, "utf8"), "foreign evidence\n");
    assert.ok(
      (await readdir(state)).includes(
        "scaffolding-transaction.json.document-transition"
      )
    );
  });
});

test("replace detects a canonical substitution and preserves all evidence", async () => {
  let attacked = false;
  await withFixture(
    async ({ path, state, store }) => {
      const originalIdentity = await store.create(await envelope());
      const originalPath = `${path}.attacker-preserved-original`;
      const replacementStore = new NodeDocumentJournalStore(path, {
        async faultInjector(point) {
          if (point.phase === "after-candidate-synced") {
            await rename(path, originalPath);
            await writeFile(path, "foreign replacement\n", {
              flag: "wx",
              mode: 0o600
            });
            attacked = true;
          }
        }
      });
      await assert.rejects(
        replacementStore.replace({
          expectedIdentity: originalIdentity,
          envelope: await envelope()
        }),
        /changed concurrently/u
      );
      assert.equal(attacked, true);
      assert.equal(await readFile(path, "utf8"), "foreign replacement\n");
      await lstat(originalPath);
      assert.ok(
        (await readdir(state)).some((entry) =>
          entry.includes(".document-transition")
        )
      );
    }
  );
});

test("replace rejects same-inode byte mutation and preserves transition evidence", async () => {
  await withFixture(async ({ path, state, store }) => {
    const originalIdentity = await store.create(await envelope());
    const replacementStore = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (point.phase === "after-candidate-synced") {
          await writeFile(path, "same inode foreign bytes\n");
        }
      }
    });

    await assert.rejects(
      replacementStore.replace({
        expectedIdentity: originalIdentity,
        envelope: await envelope("preexisting")
      }),
      /canonical bytes changed concurrently/u
    );

    assert.equal(await readFile(path, "utf8"), "same inode foreign bytes\n");
    assert.ok(
      (await readdir(state)).includes(
        "scaffolding-transaction.json.document-transition"
      )
    );
  });
});

test("private cleanup never deletes a pathname-swapped foreign file", async () => {
  await withFixture(async ({ path, state }) => {
    let ownedCandidatePath;
    const store = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (
          point.phase === "before-private-cleanup" &&
          point.evidence === "candidate"
        ) {
          ownedCandidatePath = `${point.path}.owned-preserved`;
          await rename(point.path, ownedCandidatePath);
          await writeFile(point.path, "foreign cleanup target\n", {
            flag: "wx",
            mode: 0o600
          });
        }
      }
    });

    await assert.rejects(
      store.create(await envelope()),
      /changed concurrently/u
    );

    assert.equal(
      await readFile(
        join(state, "scaffolding-transaction.json.document-transition"),
        "utf8"
      ),
      "foreign cleanup target\n"
    );
    await lstat(ownedCandidatePath);
    assert.ok(
      (await readdir(state)).some((entry) =>
        entry.endsWith(".document-transition.owned-preserved")
      )
    );
  });
});

test("shared quarantine preserves a pathname replacement made after proof", async () => {
  await withFixture(async ({ path, state, store }) => {
    const identity = await store.create(await envelope());
    const originalPath = `${path}.owned-preserved`;
    const attacked = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (point.phase === "before-shared-quarantine") {
          await rename(path, originalPath);
          await writeFile(path, "foreign shared target\n", {
            flag: "wx",
            mode: 0o600
          });
        }
      }
    });

    await assert.rejects(
      attacked.remove(identity),
      /canonical bytes changed concurrently/u
    );

    await lstat(originalPath);
    assert.ok(
      (await readdir(state)).some((entry) =>
        entry.includes(".document-quarantine.")
      )
    );
    const quarantineDirectory = (await readdir(state)).find((entry) =>
      entry.includes(".document-quarantine.")
    );
    assert.equal(
      await readFile(join(state, quarantineDirectory, "evidence"), "utf8"),
      "foreign shared target\n"
    );
  });
});

test("an interrupted removal leaves a quarantine barrier and fails closed", async () => {
  await withFixture(async ({ path, state, store }) => {
    const identity = await store.create(await envelope());
    const interrupted = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (point.phase === "after-canonical-quarantined") {
          throw new Error("injected removal interruption");
        }
      }
    });
    await assert.rejects(
      interrupted.remove(identity),
      /injected removal interruption/u
    );
    assert.ok(
      (await readdir(state)).some((entry) =>
        entry.includes(".document-quarantine.")
      )
    );
    await assert.rejects(
      store.read(),
      /transition evidence was preserved/u
    );
  });
});

test("rejects non-canonical slots, invalid identities, and non-regular journals", async () => {
  await withFixture(async ({ path, store }) => {
    assert.throws(
      () => new NodeDocumentJournalStore(`${path}.other`),
      /historical Foundation transaction slot/u
    );
    const identity = await store.create(await envelope());
    await assert.rejects(
      store.remove({ ...identity, ino: "0" }),
      /identity is invalid or zero/u
    );
    await assert.rejects(
      store.remove({ ...identity, ino: "9".repeat(21) }),
      /identity is invalid or zero/u
    );
  });

  await withFixture(async ({ path, store }) => {
    await mkdir(path);
    await assert.rejects(store.read(), /stable bounded regular file/u);
  });
});

test("preserves a legacy v1 journal as manual recovery evidence", async () => {
  await withFixture(async ({ path, state, store }) => {
    const legacyBytes = `${canonicalJson(fixture.documentEnvelope)}\n`;
    await writeFile(path, legacyBytes, { flag: "wx", mode: 0o600 });

    await assert.rejects(
      store.read(),
      /invalid strict canonical JSON/u
    );

    assert.equal(await readFile(path, "utf8"), legacyBytes);
    assert.deepEqual(await readdir(state), [
      "scaffolding-transaction.json"
    ]);
  });
});

test("rejects a legacy v1 journal before creating transition evidence", async () => {
  await withFixture(async ({ state, store }) => {
    await assert.rejects(
      store.create(fixture.documentEnvelope),
      /document transaction envelope|schema|payload/iu
    );
    assert.deepEqual(await readdir(state), []);
  });
});
