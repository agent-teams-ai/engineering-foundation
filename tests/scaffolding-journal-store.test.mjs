import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { NodeScaffoldJournalStore } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-scaffold-journal-store.js";
import { freshAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal-state.js";
import { assertNoOwnedCleanupResidue } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-operation-state.js";
import { planScaffoldFromFile } from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { createScriptedSequence } from "./support/scripted-sequence.mjs";
import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import {
  canonicalJson,
  compileRepositoryMutationEnvelope
} from "../packages/repository-mutation/dist/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer"
);

function journalWithOperationState(value, state) {
  return {
    ...value,
    operations: value.operations.map((operation, index) =>
      index === 0 ? { ...operation, state } : operation
    )
  };
}

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "scaffold-journal-store-"));
  await cp(fixtureRoot, root, { recursive: true });
  const state = join(root, ".agent-teams-local");
  await mkdir(state, { recursive: true });
  const path = join(state, "scaffolding-transaction.json");
  try {
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: "intents/create-fixture.yaml"
    });
    await run({
      journal: freshAuthorityScaffoldJournal(plan),
      path,
      root,
      state
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("writes and recovers the closed Foundation schema6 owner composition", async () => {
  await withStore(async ({ journal, path, root }) => {
    const store = new NodeScaffoldJournalStore(root);
    await store.create(journal);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    assert.equal(envelope.schemaVersion, 6);
    assert.equal(envelope.operationKind, "scaffolding");
    assert.equal(envelope.recoveryHandler.id, "agent-teams.engineering-foundation.scaffolding/v1");
    assert.equal(envelope.payloadKind, "agent-teams.engineering-foundation.scaffold-recovery-journal/v1");
    assert.equal(envelope.state, "PREPARED");
    assert.equal(envelope.ownerArtifact.name, "@agent-teams/engineering-foundation");
    assert.equal(envelope.kernelArtifact.name, "@agent-teams/repository-mutation");
    assert.deepEqual((await store.read()).journal, journal);

    const status = await (await createNodeFoundationTransactionCoordinator(root)).inspect();
    assert.equal(status.state, "pending", JSON.stringify(status));
    assert.equal(status.operationKind, "scaffolding");
    assert.equal(status.format, "foundation-scaffolding-envelope-v6");
  });
});

for (const corruption of ["handler", "payload-kind", "state", "owner-build"]) {
  test(`preserves schema6 Foundation evidence with wrong ${corruption}`, async () => {
    await withStore(async ({ journal, path, root }) => {
      const store = new NodeScaffoldJournalStore(root);
      await store.create(journal);
      const envelope = JSON.parse(await readFile(path, "utf8"));
      const input = {
        operationKind: envelope.operationKind,
        recoveryHandler: envelope.recoveryHandler,
        ownerArtifact: envelope.ownerArtifact,
        kernelArtifact: envelope.kernelArtifact,
        adapterContractVersion: envelope.adapterContractVersion,
        payloadKind: envelope.payloadKind,
        state: envelope.state,
        payload: envelope.payload
      };
      if (corruption === "handler") {
        input.recoveryHandler = { ...input.recoveryHandler, id: "unknown-handler/v1" };
      } else if (corruption === "payload-kind") {
        input.payloadKind = "unknown-payload/v1";
      } else if (corruption === "state") {
        input.state = "UNKNOWN";
      } else {
        input.ownerArtifact = {
          ...input.ownerArtifact,
          buildIdentity: `sha256:${"0".repeat(64)}`
        };
      }
      const incompatible = compileRepositoryMutationEnvelope(input);
      const evidence = `${canonicalJson(incompatible)}\n`;
      await writeFile(path, evidence, "utf8");
      const status = await (await createNodeFoundationTransactionCoordinator(root)).inspect();
      assert.equal(status.state, "manual-recovery-required");
      assert.equal(await readFile(path, "utf8"), evidence);
    });
  });
}

test("creates without replacing or mutating a foreign canonical slot", async () => {
  await withStore(async ({ journal, path, root, state }) => {
    const store = new NodeScaffoldJournalStore(root);
    await writeFile(path, "foreign canonical\n", "utf8");
    await assert.rejects(store.create(journal), /invalid strict JSON/u);
    assert.equal(await readFile(path, "utf8"), "foreign canonical\n");
    assert.ok(!(await readdir(state)).includes("scaffolding-transaction.json.tmp"));
  });
});

test("replace rejects same bytes on a different inode without mutation", async () => {
  await withStore(async ({ journal, path, root, state }) => {
    const store = new NodeScaffoldJournalStore(root);
    const initial = await store.create(journal);
    const bytes = await readFile(path);
    await rename(path, `${path}.original`);
    await writeFile(path, bytes);

    await assert.rejects(
      store.replace(initial, journalWithOperationState(journal, "publishing")),
      /identity or bytes changed/u
    );
    assert.deepEqual(await readFile(path), bytes);
    await stat(`${path}.original`);
    assert.ok(!(await readdir(state)).includes("scaffolding-transaction.json.tmp"));
  });
});

test("replace never overwrites a slot occupied before publication", async () => {
  await withStore(async ({ journal, path, root }) => {
    let store;
    store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (point.phase === "after-shared-quarantine-synced") {
          await writeFile(path, "foreign during transition\n", "utf8");
        }
      }
    });
    const initial = await store.create(journal);
    await assert.rejects(
      store.replace(initial, journalWithOperationState(journal, "publishing")),
      /slot is occupied/u
    );
    assert.equal(await readFile(path, "utf8"), "foreign during transition\n");
  });
});

test("stabilization exposes committed canonical and transition residue", async () => {
  await withStore(async ({ journal, root }) => {
    let fault = false;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: (point) => {
        if (point.phase === "after-canonical-synced") {
          fault = true;
          throw new Error("commit then throw");
        }
      }
    });
    await assert.rejects(store.create(journal), /commit then throw/u);
    assert.equal(fault, true);
    const observation = await store.stabilizeForReconciliation();
    assert.ok(observation.canonical);
    assert.deepEqual(observation.residueNames, [
      "scaffolding-transaction.json.tmp"
    ]);
  });
});

test("private retirement never deletes a pathname-swapped foreign file", async () => {
  await withStore(async ({ journal, root, state }) => {
    let swappedPath;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (
          point.phase === "before-private-retirement" &&
          point.evidence === "previous"
        ) {
          const quarantine = (await readdir(state)).find((entry) =>
            entry.startsWith("scaffolding-transaction.json.scaffold-quarantine.")
          );
          assert.ok(quarantine);
          swappedPath = join(state, quarantine, "evidence");
          await rename(swappedPath, `${swappedPath}.owned`);
          await writeFile(swappedPath, "foreign retired replacement\n", "utf8");
        }
      }
    });
    const initial = await store.create(journal);
    await assert.rejects(
      store.replace(initial, journalWithOperationState(journal, "publishing")),
      /identity or bytes changed/u
    );
    assert.ok(swappedPath);
    assert.equal(await readFile(swappedPath, "utf8"), "foreign retired replacement\n");
    await stat(`${swappedPath}.owned`);
  });
});

test("logical retirement never deletes a replacement after the final proof", async () => {
  await withStore(async ({ journal, root, state }) => {
    let swappedPath;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (
          point.phase === "before-logical-retirement" &&
          point.evidence === "candidate"
        ) {
          const retired = (await readdir(state)).find((entry) =>
            entry.startsWith("scaffolding-transaction.json.scaffold-retired.")
          );
          assert.ok(retired);
          swappedPath = join(state, retired, "evidence");
          await rename(swappedPath, `${swappedPath}.owned`);
          await writeFile(swappedPath, "foreign final replacement\n", "utf8");
        }
      }
    });
    await assert.rejects(store.create(journal), /identity or bytes changed/u);
    assert.equal(await readFile(swappedPath, "utf8"), "foreign final replacement\n");
    await stat(`${swappedPath}.owned`);
  });
});

test("terminal retirement rejects a pre-existing link without escaping state", async () => {
  await withStore(async ({ journal, root, state }) => {
    const outside = await mkdtemp(join(tmpdir(), "scaffold-journal-outside-"));
    try {
      await symlink(
        outside,
        join(state, "scaffolding-transaction.json.completed-scaffold-evidence"),
        process.platform === "win32" ? "junction" : "dir"
      );
      const store = new NodeScaffoldJournalStore(root);
      await assert.rejects(
        store.create(journal),
        /real operation-owned directory/u
      );
      assert.deepEqual(await readdir(outside), []);
      assert.equal(
        (await readdir(state)).some((entry) =>
          entry.startsWith("scaffolding-transaction.json.scaffold-retired.")),
        true
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("create never reports success after canonical replacement during retirement", async () => {
  await withStore(async ({ journal, path, root }) => {
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (
          point.phase === "before-private-retirement" &&
          point.evidence === "candidate"
        ) {
          await rename(path, `${path}.owned-canonical`);
          await writeFile(path, "foreign canonical replacement\n", "utf8");
        }
      }
    });

    await assert.rejects(store.create(journal), /identity or bytes changed/u);
    assert.equal(await readFile(path, "utf8"), "foreign canonical replacement\n");
    await stat(`${path}.owned-canonical`);
  });
});

test("remove never reports success after canonical recreation", async () => {
  await withStore(async ({ journal, path, root }) => {
    let recreate = false;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (
          recreate &&
          point.phase === "before-private-retirement" &&
          point.evidence === "previous"
        ) {
          await writeFile(path, "foreign canonical recreation\n", "utf8");
        }
      }
    });
    const initial = await store.create(journal);
    recreate = true;

    await assert.rejects(
      store.remove(initial),
      /invalid strict JSON|recreated concurrently/u
    );
    assert.equal(await readFile(path, "utf8"), "foreign canonical recreation\n");
  });
});

test("historical candidate pathname replacement is preserved", async () => {
  await withStore(async ({ journal, path, root }) => {
    const candidate = `${path}.tmp`;
    let replacement;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (point.phase === "after-candidate-synced") {
          await rename(candidate, `${candidate}.owned`);
          await writeFile(candidate, "foreign candidate replacement\n", "utf8");
          replacement = candidate;
        }
      }
    });
    await assert.rejects(store.create(journal), /temporary identity or bytes changed/u);
    assert.equal(await readFile(replacement, "utf8"), "foreign candidate replacement\n");
    await stat(`${candidate}.owned`);
  });
});

test("create never links a same-inode mutated temporary", async () => {
  await withStore(async ({ journal, path, root }) => {
    const candidate = `${path}.tmp`;
    const foreign = "mutated journal temporary\n";
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (point.phase === "after-candidate-synced") {
          await writeFile(candidate, foreign, "utf8");
        }
      }
    });

    await assert.rejects(
      store.create(journal),
      /temporary identity or bytes changed/u
    );
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.equal(await readFile(candidate, "utf8"), foreign);
  });
});

test("terminal retirement rejects a pre-existing link during removal", async () => {
  await withStore(async ({ journal, root, state }) => {
    const store = new NodeScaffoldJournalStore(root);
    const initial = await store.create(journal);
    const terminalRoot = join(state, "scaffolding-transaction.json.completed-scaffold-evidence");
    const outside = await mkdtemp(join(tmpdir(), "scaffold-journal-remove-outside-"));
    try {
      await rm(terminalRoot, { force: true, recursive: true });
      await symlink(
        outside,
        terminalRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        store.remove(initial),
        /real operation-owned directory/u
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("candidate authority is re-proved immediately before canonical publication", async () => {
  await withStore(async ({ journal, path, root }) => {
    const candidate = `${path}.tmp`;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (point.phase === "before-canonical-link") {
          await rename(candidate, `${candidate}.owned`);
          await writeFile(candidate, "foreign late candidate\n", "utf8");
        }
      }
    });

    await assert.rejects(
      store.create(journal),
      /temporary identity or bytes changed/u
    );
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.equal(await readFile(candidate, "utf8"), "foreign late candidate\n");
    await stat(`${candidate}.owned`);
  });
});

test("replace re-proves prior authority immediately before shared quarantine", async () => {
  await withStore(async ({ journal, path, root }) => {
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (point.phase === "before-shared-quarantine") {
          await writeFile(path, "foreign in-place mutation\n", "utf8");
        }
      }
    });
    const initial = await store.create(journal);

    await assert.rejects(
      store.replace(initial, journalWithOperationState(journal, "publishing")),
      /identity or bytes changed/u
    );
    assert.equal(await readFile(path, "utf8"), "foreign in-place mutation\n");
    await stat(`${path}.tmp`);
  });
});

test("remove re-proves prior authority immediately before shared quarantine", async () => {
  await withStore(async ({ journal, path, root }) => {
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: async (point) => {
        if (point.phase === "before-shared-quarantine") {
          await rename(path, `${path}.owned`);
          await writeFile(path, "foreign removal replacement\n", "utf8");
        }
      }
    });
    const initial = await store.create(journal);

    await assert.rejects(store.remove(initial), /identity or bytes changed/u);
    assert.equal(await readFile(path, "utf8"), "foreign removal replacement\n");
    await stat(`${path}.owned`);
  });
});

test("shared rename syncs destination before source", async () => {
  await withStore(async ({ journal, root, state }) => {
    const syncs = [];
    let recording = false;
    let sharedRenameSyncs;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: (point) => {
        if (point.phase === "before-shared-quarantine") {
          recording = true;
          return;
        }
        if (recording && point.phase === "before-directory-sync") {
          sharedRenameSyncs?.consume(point.role);
          syncs.push({ path: point.path, role: point.role });
          if (point.role === "source") {
            recording = false;
          }
        }
      }
    });
    const initial = await store.create(journal);
    syncs.length = 0;
    sharedRenameSyncs = createScriptedSequence(
      ["destination", "source"],
      "shared quarantine rename syncs",
    );
    await store.replace(initial, journalWithOperationState(journal, "publishing"));
    sharedRenameSyncs.assertConsumed();

    assert.equal(syncs[0].role, "destination");
    assert.match(syncs[0].path, /\.scaffold-quarantine\./u);
    assert.deepEqual(syncs[1], { path: state, role: "source" });
  });
});

test("post-removal failure stabilizes to a durable empty slot", async () => {
  await withStore(async ({ journal, root }) => {
    let fail = false;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: (point) => {
        if (fail && point.phase === "before-final-directory-sync") {
          throw new Error("remove commit then throw");
        }
      }
    });
    const initial = await store.create(journal);
    fail = true;

    await assert.rejects(store.remove(initial), /remove commit then throw/u);
    await assert.rejects(store.read(), /must be stabilized/u);
    assert.deepEqual(await store.stabilizeForReconciliation(), {
      outcome: "committed"
    });
  });
});

test("stabilization keeps mutation ambiguity sticky when durability is unproven", async () => {
  await withStore(async ({ journal, root }) => {
    let stabilizationFails = false;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: (point) => {
        if (point.phase === "after-canonical-synced") {
          throw new Error("publication result ambiguous");
        }
        if (
          stabilizationFails &&
          point.phase === "before-reconciliation-directory-sync"
        ) {
          throw new Error("reconciliation durability failed");
        }
      }
    });
    await assert.rejects(store.create(journal), /publication result ambiguous/u);
    stabilizationFails = true;
    await assert.rejects(
      store.stabilizeForReconciliation(),
      /reconciliation durability failed/u
    );
    await assert.rejects(store.read(), /must be stabilized/u);
  });
});

test("rejects an invalid journal before creating transaction evidence", async () => {
  await withStore(async ({ path, root, state }) => {
    const store = new NodeScaffoldJournalStore(root);
    await assert.rejects(
      store.create({ schemaVersion: 1, state: "PREPARED" }),
      /does not satisfy the released contract/u
    );
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.ok(!(await readdir(state)).includes("scaffolding-transaction.json.tmp"));
  });
});

test("strict directory durability failure remains sticky", async () => {
  await withStore(async ({ journal, root }) => {
    const store = new NodeScaffoldJournalStore(root, {
      syncDirectoryStrictly: async () => {
        throw new Error("strict directory durability unsupported");
      }
    });
    await assert.rejects(
      store.create(journal),
      /strict directory durability unsupported/u
    );
    await assert.rejects(
      store.stabilizeForReconciliation(),
      /strict directory durability unsupported/u
    );
    await assert.rejects(store.read(), /must be stabilized/u);
  });
});

test("transition residue keeps ambiguity sticky after a durable observation", async () => {
  await withStore(async ({ journal, path, root }) => {
    const candidate = `${path}.tmp`;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: (point) => {
        if (point.phase === "after-canonical-synced") {
          throw new Error("durable create result");
        }
      }
    });
    await assert.rejects(store.create(journal), /durable create result/u);
    assert.equal(
      (await store.stabilizeForReconciliation()).outcome,
      "recovery-required"
    );
    await rename(candidate, `${candidate}.externally-moved`);
    await assert.rejects(store.read(), /must be stabilized/u);
  });
});

test("replace commit-then-throw exposes committed after clean retirement", async () => {
  await withStore(async ({ journal, root }) => {
    let replaceActive = false;
    const store = new NodeScaffoldJournalStore(root, {
      faultInjector: (point) => {
        if (
          replaceActive &&
          point.phase === "before-final-directory-sync" &&
          point.mutation === "replace"
        ) {
          throw new Error("replace commit then throw");
        }
      }
    });
    const initial = await store.create(journal);
    replaceActive = true;
    await assert.rejects(
      store.replace(initial, journalWithOperationState(journal, "publishing")),
      /replace commit then throw/u
    );
    const observation = await store.stabilizeForReconciliation();
    assert.equal(observation.outcome, "committed");
    assert.equal(observation.stored.journal.operations[0].state, "publishing");
  });
});

test("bounds cleanup-residue enumeration before whole-directory allocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scaffold-operation-state-bounds-"));
  try {
    const parent = join(root, "managed");
    await mkdir(parent);
    await Promise.all(Array.from({ length: 1025 }, (_, index) =>
      writeFile(join(parent, "entry-" + index), "")));
    await assert.rejects(assertNoOwnedCleanupResidue(root, {
      planDigest: "sha256:" + "0".repeat(64),
      operations: [{ id: "fixture", path: "managed/output.txt" }]
    }), /too many entries/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bounded state scan fails closed after 1024 entries", async () => {
  await withStore(async ({ root, state }) => {
    await Promise.all(
      Array.from({ length: 1025 }, (_, index) =>
        writeFile(join(state, `entry-${String(index).padStart(4, "0")}`), "")
      )
    );
    const store = new NodeScaffoldJournalStore(root);
    await assert.rejects(store.read(), /too many entries/u);
  });
});

test("historical document quarantine residue blocks scaffolding", async () => {
  await withStore(async ({ journal, root, state }) => {
    await mkdir(
      join(state, "scaffolding-transaction.json.document-quarantine.legacy")
    );
    const store = new NodeScaffoldJournalStore(root);
    await assert.rejects(store.create(journal), /reconciled before mutation/u);
  });
});
