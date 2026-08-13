import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyDocumentationPlan,
  planDocumentationDocument,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import {
  applyNodeDocumentationPlanPrivately,
} from "../packages/engineering-foundation/dist/document-authoring/composition/node-document-writing-private.js";
import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import {
  applyAuthorityFilesystemScaffoldWithFaultInjection,
} from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-workspace.js";

const documentFixtureRoot = fileURLToPath(new URL(
  "fixtures/document-planning/orchestrator/",
  import.meta.url,
));
const scaffoldingFixtureRoot = fileURLToPath(new URL(
  "fixtures/scaffolding-authority-consumer/",
  import.meta.url,
));

function deferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
}

function statePaths(root) {
  const state = join(root, ".agent-teams-local");
  return {
    journal: join(state, "scaffolding-transaction.json"),
    lock: join(state, "foundation-operation.lock"),
  };
}

async function assertTypedLockConflict(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.name, "FoundationError");
    assert.equal(error?.code, "LOCAL_STATE_INVALID");
    assert.match(error?.message, /operation is active|lock is not safely recoverable/u);
    return true;
  });
}

async function withPlans(run) {
  const root = await mkdtemp(join(tmpdir(), "foundation-doc-scaffold-race-"));
  try {
    await cp(documentFixtureRoot, root, { recursive: true });
    const cases = JSON.parse(await readFile(join(root, "cases.json"), "utf8"));
    const vector = cases.cases.find(({ name }) => name === "adr");
    assert.ok(vector);
    const documentPlan = await planDocumentationDocument({
      consumerRoot: root,
      intent: vector.intent,
      profilePath: cases.profilePath,
    });

    await cp(scaffoldingFixtureRoot, root, { recursive: true });
    const scaffoldConfigPath = join(
      root,
      "architecture/foundation/scaffolding.yaml",
    );
    const scaffoldConfig = await readFile(scaffoldConfigPath, "utf8");
    await mkdir(join(root, "scaffold-docs"));
    await cp(
      join(root, "docs/decisions/adr-0060.md"),
      join(root, "scaffold-docs/adr-0060.md"),
    );
    await rm(join(root, "docs/decisions/adr-0060.md"));
    await writeFile(
      scaffoldConfigPath,
      scaffoldConfig.replace("documentRoots: [docs]", "documentRoots: [scaffold-docs]"),
      "utf8",
    );
    const scaffoldPlan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: "intents/create-fixture.yaml",
    });
    await run({ documentPlan, root, scaffoldPlan });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test(
  "a durable scaffolding transaction serializes document apply without evidence loss",
  { timeout: 30_000 },
  async () => withPlans(async ({ documentPlan, root, scaffoldPlan }) => {
    const entered = deferred();
    const resume = deferred();
    let paused = false;
    const scaffolding = applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async ({ phase }) => {
        if (!paused && phase === "after-journal-prepared") {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
      },
    );
    try {
      await entered.promise;
      const paths = statePaths(root);
      const before = {
        journal: await readFile(paths.journal),
        lock: await readFile(paths.lock),
      };

      await assertTypedLockConflict(applyDocumentationPlan({
        consumerRoot: root,
        plan: documentPlan,
      }));

      assert.deepEqual(await readFile(paths.journal), before.journal);
      assert.deepEqual(await readFile(paths.lock), before.lock);
      await assertAbsent(join(root, documentPlan.destination));
    } finally {
      resume.resolve();
    }

    const receipt = await scaffolding;
    assert.equal(receipt.outcome, "applied");
    for (const operation of scaffoldPlan.operations) {
      await lstat(join(root, operation.path));
    }
    await assertAbsent(statePaths(root).journal);
    await assertAbsent(statePaths(root).lock);
  }),
);

test(
  "a durable document transaction serializes scaffold apply without evidence loss",
  { timeout: 30_000 },
  async () => withPlans(async ({ documentPlan, root, scaffoldPlan }) => {
    const entered = deferred();
    const resume = deferred();
    let paused = false;
    const document = applyNodeDocumentationPlanPrivately(
      { consumerRoot: root, plan: documentPlan },
      {
        async faultInjector({ phase }) {
          if (!paused && phase === "after-prepared-journal-durable") {
            paused = true;
            entered.resolve();
            await resume.promise;
          }
        },
      },
    );
    try {
      await entered.promise;
      const paths = statePaths(root);
      const before = {
        journal: await readFile(paths.journal),
        lock: await readFile(paths.lock),
      };

      await assertTypedLockConflict(applyFilesystemScaffold(root, scaffoldPlan));

      assert.deepEqual(await readFile(paths.journal), before.journal);
      assert.deepEqual(await readFile(paths.lock), before.lock);
      for (const operation of scaffoldPlan.operations) {
        await assertAbsent(join(root, operation.path));
      }
    } finally {
      resume.resolve();
    }

    const receipt = await document;
    assert.equal(receipt.outcome, "applied");
    await lstat(join(root, documentPlan.destination));
    await assertAbsent(statePaths(root).journal);
    await assertAbsent(statePaths(root).lock);
  }),
);
