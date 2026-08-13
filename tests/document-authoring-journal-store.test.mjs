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
