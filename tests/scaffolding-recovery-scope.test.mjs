import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  planScaffoldFromFile,
  recoverFilesystemScaffold,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import {
  recoverAuthorityFilesystemScaffoldWithFaultInjection,
} from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-recovery.js";
import {
  sha256Json,
} from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";

const fixtureRoot = fileURLToPath(new URL(
  "fixtures/scaffolding-authority-consumer/",
  import.meta.url,
));
const scopeMismatchMessage =
  "Scaffolding recovery scope does not match the prepared journal; the journal and outputs were preserved.";

async function withConsumer(run) {
  const root = await mkdtemp(join(tmpdir(), "scaffold-recovery-scope-"));
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

function barrierPath(root) {
  return join(root, ".agent-teams-local", "foundation-operation.lock");
}

function recoveryScope(plan) {
  return {
    projectId: plan.projectId,
    configPath: plan.authority.configPath,
    targetCatalogPath: plan.authority.targetCatalogPath,
    compositionId: plan.intent.compositionId,
  };
}

function preparedJournal(plan) {
  return {
    schemaVersion: 1,
    state: "PREPARED",
    plan,
    operations: plan.operations.map((operation) => ({
      operationId: operation.id,
      path: operation.path,
      state: "pending",
    })),
  };
}

function journalBytes(plan) {
  return Buffer.from(`${JSON.stringify(preparedJournal(plan), null, 2)}\n`);
}

async function writePreparedJournal(root, plan, path = journalPath(root)) {
  const bytes = journalBytes(plan);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

async function snapshotPath(path) {
  try {
    const metadata = await stat(path);
    assert.equal(metadata.isFile(), true);
    return {
      state: "file",
      bytes: await readFile(path),
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "missing" };
    }
    throw error;
  }
}

async function materializeOutput(root, operation, bytes, mode) {
  const path = join(root, operation.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode });
}

async function prepareScopeMismatchEvidence(root, plan) {
  assert.ok(plan.operations.length >= 2);
  const [exactOperation, conflictingOperation] = plan.operations;
  assert.ok(exactOperation);
  assert.ok(conflictingOperation);
  const exactBytes = Buffer.from(exactOperation.after.contentBase64, "base64");
  const conflictingBytes = Buffer.from(
    "preexisting output that conflicts with the prepared Plan\r\n",
  );
  assert.notDeepEqual(
    conflictingBytes,
    Buffer.from(conflictingOperation.after.contentBase64, "base64"),
  );
  await writePreparedJournal(root, plan);
  await materializeOutput(
    root,
    exactOperation,
    exactBytes,
    Number.parseInt(exactOperation.after.mode, 8),
  );
  await materializeOutput(root, conflictingOperation, conflictingBytes, 0o600);
  return {
    journal: await snapshotPath(journalPath(root)),
    outputs: await Promise.all(plan.operations.map(async (operation) => ({
      path: operation.path,
      snapshot: await snapshotPath(join(root, operation.path)),
    }))),
  };
}

async function assertScopeMismatchEvidenceUnchanged(root, before) {
  assert.deepEqual(await snapshotPath(journalPath(root)), before.journal);
  for (const output of before.outputs) {
    assert.deepEqual(
      await snapshotPath(join(root, output.path)),
      output.snapshot,
    );
  }
  const barrier = await snapshotPath(barrierPath(root));
  assert.equal(barrier.state, "file");
  if (process.platform !== "win32") {
    assert.equal(barrier.mode, 0o600);
  }
  const evidence = JSON.parse(barrier.bytes.toString("utf8"));
  assert.deepEqual(Object.keys(evidence).toSorted(), [
    "kind",
    "schemaVersion",
    "token",
  ]);
  assert.equal(evidence.kind, "transaction-barrier");
  assert.equal(evidence.schemaVersion, 1);
  assert.match(
    evidence.token,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
}

function withRecomputedPlanDigest(value) {
  const { planDigest: _planDigest, ...body } = value;
  return { ...body, planDigest: sha256Json(body) };
}

async function assertOutputsMissing(root, plan) {
  for (const operation of plan.operations) {
    await assert.rejects(
      stat(join(root, operation.path)),
      (error) => error?.code === "ENOENT",
    );
  }
}

async function assertRetainedBarrier(root) {
  const barrier = JSON.parse(await readFile(
    barrierPath(root),
    "utf8",
  ));
  assert.equal(barrier.kind, "transaction-barrier");
}

function isScopeMismatch(error) {
  assert.equal(error?.code, "SCAFFOLD_RECOVERY_REQUIRED");
  assert.equal(error.message, scopeMismatchMessage);
  assert.deepEqual(error.diagnostics, [{
    ruleId: "scaffolding.recovery.scope-mismatch",
    severity: "error",
    phase: "recovery",
    subject: "scaffold-recovery-scope",
    message: scopeMismatchMessage,
    remediation:
      "Retry only with the exact project, authority paths, and Composition expected by the caller.",
  }]);
  return true;
}

test("keeps one-argument recovery behavior and exact scoped recovery replay", async () => {
  assert.equal(recoverFilesystemScaffold.length, 1);
  await withConsumer(async (root, plan) => {
    await writePreparedJournal(root, plan);
    const recovered = await recoverFilesystemScaffold(root);
    assert.equal(recovered?.outcome, "failed-recovered");
  });
  await withConsumer(async (root, plan) => {
    await writePreparedJournal(root, plan);
    const scope = recoveryScope(plan);
    const recovered = await recoverFilesystemScaffold(root, scope);
    assert.equal(recovered?.outcome, "failed-recovered");
    assert.equal(await recoverFilesystemScaffold(root, scope), undefined);
  });
});

test("fails closed for explicit undefined and excess runtime arguments", async () => {
  assert.equal(recoverFilesystemScaffold.length, 1);
  await withConsumer(async (root, plan) => {
    await assert.rejects(
      recoverFilesystemScaffold(root, void 0),
      (error) => {
        assert.equal(error?.code, "SCAFFOLD_INPUT_INVALID");
        assert.equal(
          error.message,
          "Scaffolding recovery scope must be a closed data object.",
        );
        assert.deepEqual(error.diagnostics, []);
        return true;
      },
    );
    await assert.rejects(
      Reflect.apply(recoverFilesystemScaffold, undefined, [
        root,
        recoveryScope(plan),
        recoveryScope(plan),
      ]),
      (error) => {
        assert.equal(error?.code, "SCAFFOLD_INPUT_INVALID");
        assert.equal(
          error.message,
          "Scaffolding recovery accepts at most one recovery scope.",
        );
        assert.deepEqual(error.diagnostics, []);
        return true;
      },
    );
    assert.deepEqual(
      await snapshotPath(join(root, ".agent-teams-local")),
      { state: "missing" },
    );
  });
});

test("snapshots the caller scope synchronously before filesystem work", async () => {
  await withConsumer(async (root, plan) => {
    await writePreparedJournal(root, plan);
    const scope = recoveryScope(plan);
    const recovery = recoverFilesystemScaffold(root, scope);
    scope.projectId = "changed-after-invocation";
    scope.configPath = "changed/config.yaml";
    scope.targetCatalogPath = "changed/catalog.yaml";
    scope.compositionId = "changed-after-invocation";
    assert.equal((await recovery)?.outcome, "failed-recovered");
  });
});

test("rejects closed-shape, ID, and descriptor violations", async () => {
  await withConsumer(async (root, plan) => {
    const scope = recoveryScope(plan);
    const missing = { ...scope };
    delete missing.compositionId;
    const extraSymbol = { ...scope };
    extraSymbol[Symbol("extension")] = true;
    let getterCalled = false;
    const accessor = { ...scope };
    Object.defineProperty(accessor, "projectId", {
      enumerable: true,
      get() {
        getterCalled = true;
        return scope.projectId;
      },
    });
    const invalid = [
      null,
      [],
      { ...scope, extension: true },
      extraSymbol,
      missing,
      { ...scope, projectId: "Bad-Project" },
      { ...scope, compositionId: "Bad-Composition" },
      accessor,
    ];
    for (const candidate of invalid) {
      await assert.rejects(
        recoverFilesystemScaffold(root, candidate),
        (error) => error?.code === "SCAFFOLD_INPUT_INVALID",
      );
    }
    assert.equal(getterCalled, false);
  });
});

test("reuses the scaffolding path policy with recovery portability bounds", async (context) => {
  const rejectedPaths = [
    ["absolute", "configPath", "/absolute/config.yaml"],
    ["drive absolute", "configPath", "C:\\absolute\\config.yaml"],
    ["backslash", "configPath", "architecture\\config.yaml"],
    ["empty segment", "configPath", "architecture//config.yaml"],
    ["parent traversal", "targetCatalogPath", "architecture/../catalog.yaml"],
    ["current-directory traversal", "targetCatalogPath", "architecture/./catalog.yaml"],
    ["reserved device", "configPath", "architecture/CON"],
    ["mixed-case reserved device extension", "configPath", "architecture/cOn.yaml"],
    ["reserved numbered device extension", "targetCatalogPath", "architecture/LpT9.catalog"],
    ["trailing dot", "targetCatalogPath", "architecture/catalog.yaml."],
    ["trailing space", "targetCatalogPath", "architecture/catalog.yaml "],
    ["over-limit UTF-8 segment", "configPath", `architecture/${"é".repeat(128)}`],
    [
      "over-limit UTF-8 path",
      "configPath",
      `${"é".repeat(127)}/${"é".repeat(127)}/abc`,
    ],
  ];
  const acceptedPaths = [
    ["normalized nested path", "configPath", "architecture/foundation/scaffolding.yaml"],
    ["published Unicode segment", "configPath", "architecture/café.yaml"],
    ["published punctuation", "targetCatalogPath", "architecture/catalog:fixture?.yaml"],
  ];

  await withConsumer(async (root, plan) => {
    for (const [name, field, path] of rejectedPaths) {
      await context.test(`rejects ${name}`, async () => {
        await assert.rejects(
          recoverFilesystemScaffold(root, {
            ...recoveryScope(plan),
            [field]: path,
          }),
          (error) => {
            assert.equal(error?.code, "SCAFFOLD_INPUT_INVALID");
            assert.equal(
              error.message,
              `Scaffolding recovery scope ${field} must be a portable repository-relative path.`,
            );
            return true;
          },
        );
      });
    }
    for (const [name, field, path] of acceptedPaths) {
      await context.test(`accepts ${name}`, async () => {
        assert.equal(
          await recoverFilesystemScaffold(root, {
            ...recoveryScope(plan),
            [field]: path,
          }),
          undefined,
        );
      });
    }
  });
});

test("every scope field mismatch is stable and preserves journal, outputs, and barrier", async (context) => {
  const mutations = {
    projectId: (scope) => ({
      ...scope,
      projectId: `${scope.projectId}-other`,
    }),
    configPath: (scope) => ({
      ...scope,
      configPath: scope.configPath.replace("architecture", "Architecture"),
    }),
    targetCatalogPath: (scope) => ({
      ...scope,
      targetCatalogPath: `case-change/${scope.targetCatalogPath}`,
    }),
    compositionId: (scope) => ({
      ...scope,
      compositionId: `${scope.compositionId}-other`,
    }),
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    await context.test(field, async () => {
      await withConsumer(async (root, plan) => {
        const before = await prepareScopeMismatchEvidence(root, plan);
        await rm(join(root, plan.authority.configPath));
        await assert.rejects(
          recoverFilesystemScaffold(root, mutate(recoveryScope(plan))),
          isScopeMismatch,
        );
        await assertScopeMismatchEvidenceUnchanged(root, before);
      });
    });
  }
});

test("fails closed when journal Intent and Composition disagree", async () => {
  await withConsumer(async (root, plan) => {
    const disagreeing = structuredClone(plan);
    disagreeing.composition.id = `${plan.composition.id}-other`;
    const persistedPlan = withRecomputedPlanDigest(disagreeing);
    const before = await prepareScopeMismatchEvidence(root, persistedPlan);
    await assert.rejects(
      recoverFilesystemScaffold(root, recoveryScope(plan)),
      isScopeMismatch,
    );
    await assertScopeMismatchEvidenceUnchanged(root, before);
  });
});

test("keeps temporary and transition residue precedence ahead of scoped continuation", async (context) => {
  for (const scenario of [
    {
      name: "orphan temporary",
      prepare: async (root, plan) =>
        writePreparedJournal(root, plan, `${journalPath(root)}.tmp`),
    },
    {
      name: "canonical and temporary",
      prepare: async (root, plan) => {
        const bytes = await writePreparedJournal(root, plan);
        await writeFile(`${journalPath(root)}.tmp`, bytes);
        return bytes;
      },
    },
    {
      name: "quarantine residue",
      prepare: async (root, plan) => {
        const bytes = await writePreparedJournal(root, plan);
        await mkdir(`${journalPath(root)}.scaffold-quarantine.fixture`);
        return bytes;
      },
    },
    {
      name: "retired residue",
      prepare: async (root, plan) => {
        const bytes = await writePreparedJournal(root, plan);
        await mkdir(`${journalPath(root)}.scaffold-retired.fixture`);
        return bytes;
      },
    },
  ]) {
    await context.test(scenario.name, async () => {
      await withConsumer(async (root, plan) => {
        await scenario.prepare(root, plan);
        const before = await readFile(
          scenario.name === "orphan temporary"
            ? `${journalPath(root)}.tmp`
            : journalPath(root),
        );
        await assert.rejects(
          recoverFilesystemScaffold(root, recoveryScope(plan)),
          (error) =>
            error?.code === "SCAFFOLD_RECOVERY_REQUIRED" &&
            error.message !== scopeMismatchMessage,
        );
        assert.deepEqual(
          await readFile(
            scenario.name === "orphan temporary"
              ? `${journalPath(root)}.tmp`
              : journalPath(root),
          ),
          before,
        );
        await assertOutputsMissing(root, plan);
      });
    });
  }
});

test("keeps unsupported-version routing ahead of scoped journal reads", async () => {
  await withConsumer(async (root, plan) => {
    const bytes = Buffer.from('{"schemaVersion":99,"future":true}\n');
    await mkdir(dirname(journalPath(root)), { recursive: true });
    await writeFile(journalPath(root), bytes);
    await assert.rejects(
      recoverFilesystemScaffold(root, recoveryScope(plan)),
      (error) =>
        error?.code === "SCAFFOLD_RECOVERY_REQUIRED" &&
        /schema version 99 is unsupported/u.test(error.message),
    );
    assert.deepEqual(await readFile(journalPath(root)), bytes);
    await assertOutputsMissing(root, plan);
  });
});

test("continues the checked record and fences a later pathname replacement", async () => {
  await withConsumer(async (root, plan) => {
    const checkedBytes = await writePreparedJournal(root, plan);
    const replacementPlan = structuredClone(plan);
    replacementPlan.composition.id = `${plan.composition.id}-replacement`;
    const replacementBytes = journalBytes(
      withRecomputedPlanDigest(replacementPlan),
    );
    const checkedPath = `${journalPath(root)}.checked-record`;
    await assert.rejects(
      recoverAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        recoveryScope(plan),
        async (point) => {
          if (point.phase === "after-recovery-scope-checked") {
            await rename(journalPath(root), checkedPath);
            await writeFile(journalPath(root), replacementBytes);
          }
        },
      ),
      (error) =>
        error?.code === "SCAFFOLD_RECOVERY_REQUIRED" &&
        error.message !== scopeMismatchMessage,
    );
    assert.deepEqual(await readFile(checkedPath), checkedBytes);
    assert.deepEqual(await readFile(journalPath(root)), replacementBytes);
    await assertOutputsMissing(root, plan);
    await assertRetainedBarrier(root);
  });
});
