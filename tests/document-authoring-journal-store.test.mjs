import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../packages/engineering-foundation/dist/canonical-json.js";
import { createDocumentTransactionEnvelope } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";
import { NodeDocumentJournalStore } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-journal-store-private.js";
import {
  createJournalReconciled,
  replaceJournalReconciled
} from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/document-journal-reconciliation.js";
import { createScriptedSequence } from "./support/scripted-sequence.mjs";

const requiresStrictDirectoryDurability = process.platform === "win32"
  ? test.skip
  : test;

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url)
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

test("scripted fault sequences fail when a planned step is skipped or reordered", () => {
  const incomplete = createScriptedSequence(
    ["prepare", "publish"],
    "fault plan",
  );
  incomplete.consume("prepare");
  assert.throws(() => incomplete.assertConsumed(), /did not consume 1 planned step/u);

  const reordered = createScriptedSequence(["prepare", "publish"], "fault plan");
  assert.throws(() => reordered.consume("publish"), /diverged at step 1/u);
});

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

requiresStrictDirectoryDurability("creates, reads, replaces, and removes canonical document journal evidence", async () => {
  await withFixture(async ({ path, store }) => {
    const first = await envelope();
    const firstAuthority = await store.create(first);
    assert.notEqual(firstAuthority.identity.dev, "0");
    assert.notEqual(firstAuthority.identity.ino, "0");
    assert.notEqual(firstAuthority.identity.birthtimeNs, "0");
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
    const secondAuthority = await store.replace({
      expectedAuthority: firstAuthority,
      envelope: replacement
    });
    assert.notEqual(secondAuthority.identity.ino, firstAuthority.identity.ino);
    assert.deepEqual((await store.read()).envelope, replacement);

    await store.remove(secondAuthority);
    assert.equal(await store.read(), undefined);
    assert.equal(
      (await readdir(join(path, ".."))).every((entry) =>
        entry.endsWith(".completed-document-evidence")),
      true
    );
  });
});

requiresStrictDirectoryDurability("terminal retirement rejects a pre-existing link without escaping state", async () => {
  await withFixture(async ({ path, state, store }) => {
    const outside = await mkdtemp(join(tmpdir(), "document-journal-outside-"));
    try {
      await symlink(
        outside,
        `${path}.completed-document-evidence`,
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        store.create(await envelope()),
        /real operation-owned directory/u
      );
      assert.deepEqual(await readdir(outside), []);
      assert.equal(
        (await readdir(state)).some((entry) =>
          entry.startsWith("scaffolding-transaction.json.document-retired.")),
        true
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

requiresStrictDirectoryDurability("reconciles create, replace, and remove only after a fresh directory sync", async () => {
  await withFixture(async ({ path }) => {
    let operation = "create";
    let failedFinalSync = false;
    const reconciliations = createScriptedSequence(
      ["create", "replace", "remove"],
      "document journal reconciliations",
    );
    const store = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (point.phase === "before-reconciliation-directory-sync") {
          reconciliations.consume(operation);
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
      store.replace({ expectedAuthority: created.authority, envelope: replacement }),
      /replace final directory sync/u
    );
    const replaced = await store.stabilizeForReconciliation();
    assert.deepEqual(replaced.envelope, replacement);

    operation = "remove";
    failedFinalSync = false;
    await assert.rejects(store.remove(replaced.authority), /remove final directory sync/u);
    assert.equal(await store.stabilizeForReconciliation(), undefined);
    reconciliations.assertConsumed();
  });
});

requiresStrictDirectoryDurability("a failed reconciliation sync never acknowledges an apparently committed journal", async () => {
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

for (const operation of ["create", "replace", "remove"]) {
  requiresStrictDirectoryDurability(`${operation} preserves a manual barrier when destination directory sync fails`, async () => {
    await withFixture(async ({ path, state, store }) => {
      let activeAuthority;
      let replacement;
      if (operation !== "create") {
        activeAuthority = await store.create(await envelope());
      }
      if (operation === "replace") {
        replacement = await envelope("preexisting");
      }
      let injected = false;
      const attacked = new NodeDocumentJournalStore(path, {
        faultInjector(point) {
          if (
            point.phase === "before-directory-sync" &&
            point.operation === operation &&
            point.role === "destination" &&
            !injected
          ) {
            injected = true;
            throw new Error(`injected ${operation} destination sync failure`);
          }
        }
      });

      const action = operation === "create"
        ? attacked.create(await envelope())
        : operation === "replace"
          ? attacked.replace({
              envelope: replacement,
              expectedAuthority: activeAuthority
            })
          : attacked.remove(activeAuthority);
      await assert.rejects(action, new RegExp(`${operation} destination sync`, "u"));

      assert.ok(
        (await readdir(state)).some((entry) =>
          entry.includes(".document-quarantine.") ||
          entry.includes(".document-retired.")
        )
      );
      await assert.rejects(
        store.stabilizeForReconciliation(),
        /transition evidence was preserved/u
      );
    });
  });
}

requiresStrictDirectoryDurability("nested quarantine retirement syncs destination, source, then state parent", async () => {
  await withFixture(async ({ path, state, store }) => {
    const authority = await store.create(await envelope());
    const observed = [];
    const subject = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (
          point.phase === "before-directory-sync" &&
          point.operation === "remove"
        ) {
          observed.push({ path: point.path, role: point.role });
        }
      }
    });

    await subject.remove(authority);

    const nestedRetirement = observed.findIndex(
      (entry, index) =>
        entry.role === "destination" &&
        observed[index + 1]?.role === "source" &&
        observed[index + 2]?.role === "state-parent"
    );
    assert.notEqual(nestedRetirement, -1);
    assert.equal(observed[nestedRetirement + 2].path, state);
    assert.equal(
      observed.filter((entry) => entry.role === "destination").length,
      4
    );
  });
});

requiresStrictDirectoryDurability("real Node create and replace commit-then-throw reconcile with opaque authority", async () => {
  await withFixture(async ({ path }) => {
    let operation = "create";
    let injected = false;
    const store = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (
          point.phase === "before-final-directory-sync" &&
          point.operation === operation &&
          !injected
        ) {
          injected = true;
          throw new Error(`injected ${operation} commit-then-throw`);
        }
      }
    });
    const runtime = {
      coordinator: {
        async inspect() {
          return { state: "recoverable" };
        }
      },
      journal: store
    };

    const first = await envelope();
    const firstAuthority = await createJournalReconciled(runtime, first);
    assert.deepEqual(Object.keys(firstAuthority.identity).toSorted(), [
      "adapter",
      "birthtimeNs",
      "dev",
      "ino",
      "version"
    ]);
    assert.match(firstAuthority.authorityDigest, /^sha256:[0-9a-f]{64}$/u);

    operation = "replace";
    injected = false;
    const replacement = await envelope("preexisting");
    const replacementAuthority = await replaceJournalReconciled(
      runtime,
      { authority: firstAuthority, envelope: first },
      replacement
    );
    assert.notEqual(
      replacementAuthority.identity.ino,
      firstAuthority.identity.ino
    );
    assert.deepEqual((await store.read()).envelope, replacement);
  });
});

requiresStrictDirectoryDurability("never overwrites a foreign canonical slot and preserves its candidate", async () => {
  await withFixture(async ({ path, state, store }) => {
    await writeFile(path, "foreign evidence\n", { flag: "wx", mode: 0o600 });
    await assert.rejects(
      store.create(await envelope()),
      /slot is occupied/u
    );
    assert.equal(await readFile(path, "utf8"), "foreign evidence\n");
    assert.equal(
      (await readdir(state)).includes(
        "scaffolding-transaction.json.document-transition"
      ),
      false
    );
  });
});

requiresStrictDirectoryDurability("occupied create preserves a readable canonical journal without transition residue", async () => {
  await withFixture(async ({ state, store }) => {
    const first = await envelope();
    await store.create(first);
    await assert.rejects(
      store.create(await envelope("preexisting")),
      /slot is occupied/u
    );
    assert.deepEqual((await store.read()).envelope, first);
    assert.equal(
      (await readdir(state)).includes(
        "scaffolding-transaction.json.document-transition"
      ),
      false
    );
  });
});

requiresStrictDirectoryDurability("replace detects a canonical substitution and preserves all evidence", async () => {
  let attacked = false;
  await withFixture(
    async ({ path, state, store }) => {
      const originalAuthority = await store.create(await envelope());
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
          expectedAuthority: originalAuthority,
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

requiresStrictDirectoryDurability("replace rejects same-inode byte mutation and preserves transition evidence", async () => {
  await withFixture(async ({ path, state, store }) => {
    const originalAuthority = await store.create(await envelope());
    const replacementStore = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (point.phase === "after-candidate-synced") {
          await writeFile(path, "same inode foreign bytes\n");
        }
      }
    });

    await assert.rejects(
      replacementStore.replace({
        expectedAuthority: originalAuthority,
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

requiresStrictDirectoryDurability("create rejects same-inode mutation after publication and preserves evidence", async () => {
  await withFixture(async ({ path, state }) => {
    const store = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (point.phase === "after-canonical-published") {
          await writeFile(path, "mutated published journal\n");
        }
      }
    });

    await assert.rejects(
      store.create(await envelope()),
      /canonical bytes changed concurrently/u
    );

    assert.equal(await readFile(path, "utf8"), "mutated published journal\n");
    assert.ok(
      (await readdir(state)).includes(
        "scaffolding-transaction.json.document-transition"
      )
    );
  });
});

requiresStrictDirectoryDurability("remove rejects same-inode mutation before quarantine and preserves it in place", async () => {
  await withFixture(async ({ path, store }) => {
    const authority = await store.create(await envelope());
    const attacked = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (point.phase === "before-shared-quarantine") {
          await writeFile(path, "mutated removal journal\n");
        }
      }
    });

    await assert.rejects(
      attacked.remove(authority),
      /canonical bytes changed concurrently/u
    );

    assert.equal(
      await readFile(path, "utf8"),
      "mutated removal journal\n"
    );
  });
});

requiresStrictDirectoryDurability("private cleanup never deletes a pathname-swapped foreign file", async () => {
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

requiresStrictDirectoryDurability("logical retirement never deletes a replacement after final proof", async () => {
  await withFixture(async ({ path }) => {
    let retiredPath;
    const store = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (
          point.phase === "before-logical-retirement" &&
          point.evidence === "candidate"
        ) {
          retiredPath = point.path;
          await rename(point.path, `${point.path}.owned-preserved`);
          await writeFile(point.path, "foreign final cleanup target\n", {
            flag: "wx",
            mode: 0o600
          });
        }
      }
    });
    await assert.rejects(store.create(await envelope()), /changed concurrently/u);
    assert.equal(await readFile(retiredPath, "utf8"), "foreign final cleanup target\n");
    await lstat(`${retiredPath}.owned-preserved`);
  });
});

requiresStrictDirectoryDurability("shared quarantine preserves a pathname replacement at the canonical path", async () => {
  await withFixture(async ({ path, state, store }) => {
    const authority = await store.create(await envelope());
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
      attacked.remove(authority),
      /canonical bytes changed concurrently/u
    );

    await lstat(originalPath);
    assert.equal(
      await readFile(path, "utf8"),
      "foreign shared target\n"
    );
    assert.equal(
      (await readdir(state)).some((entry) =>
        entry.includes(".document-quarantine.")
      ),
      true
    );
  });
});

requiresStrictDirectoryDurability("shared quarantine verifies canonical evidence after the mutation hook", async () => {
  await withFixture(async ({ path, store }) => {
    const authority = await store.create(await envelope());
    const events = [];
    const attacked = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (point.phase === "before-shared-quarantine") {
          await writeFile(path, "captured foreign bytes\n");
          events.push("mutated");
        }
        if (
          point.phase === "before-directory-sync" &&
          point.operation === "remove"
        ) {
          events.push(`sync:${point.role}`);
        }
      }
    });

    await assert.rejects(attacked.remove(authority), /canonical bytes/u);
    assert.deepEqual(events, ["mutated"]);
    assert.equal(await readFile(path, "utf8"), "captured foreign bytes\n");
  });
});

requiresStrictDirectoryDurability("retired capture is synced before rejecting a private pathname swap", async () => {
  await withFixture(async ({ path, state }) => {
    const events = [];
    const store = new NodeDocumentJournalStore(path, {
      async faultInjector(point) {
        if (
          point.phase === "before-directory-sync" &&
          point.operation === "create" &&
          point.role === "destination"
        ) {
          await writeFile(
            join(point.path, "evidence"),
            "captured retired foreign bytes\n"
          );
          events.push("mutated");
        }
        if (
          point.phase === "before-directory-sync" &&
          point.operation === "create"
        ) {
          events.push(`sync:${point.role}`);
        }
      }
    });

    await assert.rejects(store.create(await envelope()), /canonical bytes/u);
    assert.deepEqual(events.slice(0, 3), [
      "mutated",
      "sync:destination",
      "sync:source"
    ]);
    assert.ok(
      (await readdir(state)).some((entry) =>
        entry.includes(".document-retired.")
      )
    );
  });
});

requiresStrictDirectoryDurability("an interrupted removal leaves a quarantine barrier and fails closed", async () => {
  await withFixture(async ({ path, state, store }) => {
    const authority = await store.create(await envelope());
    const interrupted = new NodeDocumentJournalStore(path, {
      faultInjector(point) {
        if (point.phase === "after-canonical-quarantined") {
          throw new Error("injected removal interruption");
        }
      }
    });
    await assert.rejects(
      interrupted.remove(authority),
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

requiresStrictDirectoryDurability("rejects non-canonical slots, invalid identities, and non-regular journals", async () => {
  await withFixture(async ({ path, store }) => {
    assert.throws(
      () => new NodeDocumentJournalStore(`${path}.other`),
      /historical Foundation transaction slot/u
    );
    const authority = await store.create(await envelope());
    await assert.rejects(
      store.remove({ ...authority, identity: { ...authority.identity, ino: "0" } }),
      /identity is invalid or zero/u
    );
    await assert.rejects(
      store.remove({
        ...authority,
        identity: { ...authority.identity, ino: "9".repeat(21) }
      }),
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
