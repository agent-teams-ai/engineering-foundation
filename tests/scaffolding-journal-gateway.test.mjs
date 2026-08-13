import assert from "node:assert/strict";
import test from "node:test";

import {
  createScaffoldJournalReconciled,
  removeScaffoldJournalReconciled,
  replaceScaffoldJournalReconciled
} from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-scaffold-journal-gateway.js";

const oldAuthority = {
  authorityDigest: "old",
  identity: { birthtimeNs: "1", dev: "1", ino: "1" }
};
const newAuthority = {
  authorityDigest: "new",
  identity: { birthtimeNs: "2", dev: "1", ino: "2" }
};
const oldJournal = { state: "old" };
const newJournal = { state: "new" };
const primary = new Error("primary mutation failure");

function failedStore(observation) {
  return {
    create: async () => { throw primary; },
    remove: async () => { throw primary; },
    replace: async () => { throw primary; },
    stabilizeForReconciliation: async () => observation
  };
}

test("returns observed authority when create committed despite an error", async () => {
  const authority = await createScaffoldJournalReconciled(
    failedStore({
      outcome: "committed",
      stored: { authority: newAuthority, journal: newJournal }
    }),
    newJournal
  );
  assert.equal(authority, newAuthority);
});

test("rethrows primary replacement failure when prior authority remains", async () => {
  await assert.rejects(
    replaceScaffoldJournalReconciled(
      failedStore({
        outcome: "not-applied",
        stored: { authority: oldAuthority, journal: oldJournal }
      }),
      { journal: oldJournal, journalAuthority: oldAuthority },
      newJournal
    ),
    (error) => error === primary
  );
});

test("accepts committed removal only when reconciliation proves it", async () => {
  await removeScaffoldJournalReconciled(
    failedStore({ outcome: "committed" }),
    { journal: oldJournal, journalAuthority: oldAuthority }
  );
  await assert.rejects(
    removeScaffoldJournalReconciled(
      failedStore({
        canonical: { authority: newAuthority, journal: newJournal },
        outcome: "recovery-required",
        residueNames: ["scaffolding-transaction.json.tmp"]
      }),
      { journal: oldJournal, journalAuthority: oldAuthority }
    ),
    (error) => error !== primary && error.code === "SCAFFOLD_RECOVERY_REQUIRED" &&
      error.cause === primary
  );
});

test("aggregates primary and failed reconciliation inspection", async () => {
  const inspection = new Error("inspection failure");
  const store = failedStore();
  store.stabilizeForReconciliation = async () => { throw inspection; };
  await assert.rejects(
    createScaffoldJournalReconciled(store, newJournal),
    (error) => error.cause instanceof AggregateError &&
      error.cause.errors[0] === primary && error.cause.errors[1] === inspection
  );
});
