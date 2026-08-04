import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  planScaffoldFromFile
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { writeAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal.js";
import { freshAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal-state.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-workspace.js";
import { assessScaffoldPlanAuthority } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-plan-authority.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-adversarial-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root) {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: "intents/create-fixture.yaml"
  });
}

function journalPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function assertMissing(path) {
  await assert.rejects(stat(path), /ENOENT/u);
}

async function setOwnerStatus(root, status) {
  const path = join(root, "docs", "decisions", "adr-0060.md");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(/^status: .+$/mu, `status: ${status}`),
    "utf8"
  );
}

test("detects authority mutation between initial and stability source reads", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const assessment = await assessScaffoldPlanAuthority(
      root,
      scaffoldPlan,
      async (point) => {
        if (point.phase === "before-authority-source-stability-check") {
          await setOwnerStatus(root, "proposed");
        }
      }
    );
    assert.deepEqual(assessment, { state: "stale" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not commit when an output changes before final authority verification", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const destination = join(root, ...first.path.split("/"));
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (point.phase === "before-final-authority-recheck") {
          await writeFile(destination, "third-party final state\n", "utf8");
        }
      }
    );

    assert.equal(receipt.outcome, "recovery-required");
    assert.equal(await readFile(destination, "utf8"), "third-party final state\n");
    assert.match(await readFile(journalPath(root), "utf8"), /"schemaVersion": 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a journal replaced after final verification", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (point.phase !== "after-final-verification") {
            return;
          }
          const journal = journalPath(root);
          const bytes = await readFile(journal);
          await rename(journal, `${journal}.foundation-original`);
          await writeFile(journal, bytes);
        }
      ),
      /journal changed before it could be removed/u
    );
    assert.match(await readFile(journalPath(root), "utf8"), /"schemaVersion": 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rechecks outputs before an already-applied Receipt", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await applyFilesystemScaffold(root, scaffoldPlan);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const destination = join(root, ...first.path.split("/"));
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (point.phase === "before-final-authority-recheck") {
          await writeFile(destination, "changed after initial classification\n", "utf8");
        }
      }
    );

    assert.equal(receipt.outcome, "rejected");
    assert.equal(
      await readFile(destination, "utf8"),
      "changed after initial classification\n"
    );
    await assertMissing(journalPath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an exact replacement of a transaction temporary", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    let replacementPath;
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (point.phase !== "after-hard-link" || point.operationIndex !== 0) {
            return;
          }
          const first = scaffoldPlan.operations[0];
          assert.ok(first);
          const parent = dirname(join(root, ...first.path.split("/")));
          const temporaryName = (await readdir(parent)).find((entry) =>
            entry.startsWith(".foundation-")
          );
          assert.ok(temporaryName);
          const temporary = join(parent, temporaryName);
          const bytes = await readFile(temporary);
          await rename(temporary, `${temporary}.original`);
          await writeFile(temporary, bytes);
          if (process.platform !== "win32") {
            await chmod(temporary, 0o644);
          }
          replacementPath = temporary;
        }
      ),
      /temporary path was replaced concurrently/u
    );
    assert.ok(replacementPath);
    assert.ok((await stat(replacementPath)).isFile());
    assert.match(await readFile(journalPath(root), "utf8"), /"publishing"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an exact replacement of the journal temporary", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const path = journalPath(root);
    const temporary = `${path}.tmp`;
    await assert.rejects(
      writeAuthorityScaffoldJournal(
        path,
        freshAuthorityScaffoldJournal(scaffoldPlan),
        async () => {
          const bytes = await readFile(temporary);
          await rename(temporary, `${temporary}.original`);
          await writeFile(temporary, bytes);
          if (process.platform !== "win32") {
            await chmod(temporary, 0o600);
          }
        }
      ),
      /journal temporary path was replaced concurrently/u
    );
    assert.ok((await stat(temporary)).isFile());
    await assertMissing(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
