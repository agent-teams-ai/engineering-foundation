import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  recoverFilesystemScaffold,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import {
  applyAuthorityFilesystemScaffoldWithFaultInjection,
} from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-workspace.js";
import {
  sha256Text,
} from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import {
  ownedTemporaryCleanupResiduePrefix,
} from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-cleanup-owned-temporary.js";

const fixtureRoot = fileURLToPath(new URL(
  "fixtures/scaffolding-authority-consumer/",
  import.meta.url,
));

async function withConsumer(run) {
  const root = await mkdtemp(join(tmpdir(), "scaffold-owned-cleanup-residue-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: "intents/create-fixture.yaml",
    });
    await run(root, plan);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function journalPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

function residuePath(root, plan, operation) {
  const destination = join(root, operation.path);
  const identity = sha256Text(`${plan.planDigest}:${operation.id}`).slice(7);
  const temporary = join(dirname(destination), `.foundation-${identity}.tmp`);
  return join(
    dirname(destination),
    `${ownedTemporaryCleanupResiduePrefix(temporary)}deterministic`,
  );
}

async function createResidue(root, plan, operation) {
  const residue = residuePath(root, plan, operation);
  await mkdir(dirname(residue), { recursive: true });
  await mkdir(residue);
  await writeFile(join(residue, "owned-temporary"), "preserved evidence\n");
  return residue;
}

async function materialize(operation, root) {
  const path = join(root, operation.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(operation.after.contentBase64, "base64"));
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
  }
}

async function assertPreserved(path, expected) {
  assert.deepEqual(await readFile(path), expected);
}

test("apply over a pending journal preserves exact owned-cleanup residue", async () => {
  await withConsumer(async (root, plan) => {
    const first = plan.operations[0];
    assert.ok(first);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, plan, (point) => {
        if (
          point.phase === "after-journal-operation-publishing" &&
          point.operationIndex === 0
        ) {
          throw new Error("stop at PUBLISHING");
        }
      }),
      /stop at PUBLISHING/u,
    );
    await materialize(first, root);
    const residue = await createResidue(root, plan, first);
    const before = {
      journal: await readFile(journalPath(root)),
      residue: await readFile(join(residue, "owned-temporary")),
    };

    const receipt = await applyFilesystemScaffold(root, plan);
    assert.equal(receipt.outcome, "recovery-required");
    await assertPreserved(journalPath(root), before.journal);
    await assertPreserved(join(residue, "owned-temporary"), before.residue);
    const barrier = JSON.parse(await readFile(
      join(root, ".agent-teams-local", "foundation-operation.lock"),
      "utf8",
    ));
    assert.equal(barrier.kind, "transaction-barrier");
  });
});

test("recovery preserves a PUBLISHING journal, exact output, barrier, and residue", async () => {
  await withConsumer(async (root, plan) => {
    const first = plan.operations[0];
    assert.ok(first);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, plan, (point) => {
        if (
          point.phase === "after-journal-operation-publishing" &&
          point.operationIndex === 0
        ) {
          throw new Error("stop at PUBLISHING");
        }
      }),
      /stop at PUBLISHING/u,
    );
    await materialize(first, root);
    const residue = await createResidue(root, plan, first);
    const before = {
      journal: await readFile(journalPath(root)),
      output: await readFile(join(root, first.path)),
      residue: await readFile(join(residue, "owned-temporary")),
    };

    const receipt = await recoverFilesystemScaffold(root);
    assert.equal(receipt?.outcome, "recovery-required");
    await assertPreserved(journalPath(root), before.journal);
    await assertPreserved(join(root, first.path), before.output);
    await assertPreserved(join(residue, "owned-temporary"), before.residue);
    const barrier = JSON.parse(await readFile(
      join(root, ".agent-teams-local", "foundation-operation.lock"),
      "utf8",
    ));
    assert.equal(barrier.kind, "transaction-barrier");
  });
});

test("already-applied finalization cannot ignore owned-cleanup residue", async () => {
  await withConsumer(async (root, plan) => {
    for (const operation of plan.operations) {
      await materialize(operation, root);
    }
    const first = plan.operations[0];
    assert.ok(first);
    const residue = await createResidue(root, plan, first);
    const evidence = await readFile(join(residue, "owned-temporary"));

    const receipt = await applyFilesystemScaffold(root, plan);
    assert.equal(receipt.outcome, "recovery-required");
    assert.notEqual(receipt.outcome, "already-applied");
    await assertPreserved(join(residue, "owned-temporary"), evidence);
  });
});

test("residue appearing after already-applied final verification prevents success", async () => {
  await withConsumer(async (root, plan) => {
    for (const operation of plan.operations) {
      await materialize(operation, root);
    }
    const first = plan.operations[0];
    assert.ok(first);
    let residue;
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, plan, async (point) => {
        if (point.phase === "after-final-verification") {
          residue = await createResidue(root, plan, first);
        }
      }),
      /cleanup residue/u
    );
    assert.ok(residue);
    await stat(join(residue, "owned-temporary"));
    await stat(journalPath(root));
    assert.equal(
      JSON.parse(await readFile(
        join(root, ".agent-teams-local", "foundation-operation.lock"),
        "utf8",
      )).kind,
      "transaction-barrier",
    );
  });
});

test("residue appearing after final verification prevents journal unlink", async () => {
  await withConsumer(async (root, plan) => {
    const first = plan.operations[0];
    assert.ok(first);
    let residue;
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, plan, async (point) => {
        if (point.phase === "after-final-verification" && residue === undefined) {
          residue = await createResidue(root, plan, first);
        }
      }),
      (error) =>
        error?.code === "SCAFFOLD_RECOVERY_REQUIRED" &&
        /cleanup residue/u.test(error.message),
    );
    assert.ok(residue);
    await stat(journalPath(root));
    await stat(join(residue, "owned-temporary"));
    const barrier = JSON.parse(await readFile(
      join(root, ".agent-teams-local", "foundation-operation.lock"),
      "utf8",
    ));
    assert.equal(barrier.kind, "transaction-barrier");
  });
});

test("nearby names that do not start with the exact prefix are inert", async () => {
  await withConsumer(async (root, plan) => {
    const first = plan.operations[0];
    assert.ok(first);
    const parent = dirname(join(root, first.path));
    await mkdir(parent, { recursive: true });
    await mkdir(join(parent, `unrelated-${basename(residuePath(root, plan, first))}`));
    assert.equal((await applyFilesystemScaffold(root, plan)).outcome, "applied");
  });
});
