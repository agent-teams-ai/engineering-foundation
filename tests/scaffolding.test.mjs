import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  assertScaffoldPlanDigest,
  MemoryScaffoldWorkspace,
  planScaffoldFromFile,
  readScaffoldPlanFile,
  recoverFilesystemScaffold
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import {
  sha256Bytes,
  sha256Json,
  sha256Text
} from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { compileScaffoldPlan } from "../packages/engineering-foundation/dist/scaffolding/kernel/compiler.js";
import { ScaffoldDefinitionRegistry } from "../packages/engineering-foundation/dist/scaffolding/kernel/definition-registry.js";
import { CONFORMANCE_FIXTURE_DEFINITIONS } from "../packages/engineering-foundation/dist/scaffolding/definitions/conformance-fixture.js";
import { loadScaffoldCompilationInput } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-input-loader.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromTest = createRequire(import.meta.url);
const typescriptCliPath = join(
  dirname(requireFromTest.resolve("typescript/package.json")),
  "bin",
  "tsc"
);
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);
const goldenVectorPath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-golden-vector-v1.json"
);
const cliPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js"
);
const crashWorkerPath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-crash-worker.mjs"
);
const filesystemWorkspaceModulePath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "scaffolding",
  "adapters",
  "node",
  "filesystem-workspace.js"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root, intent = "intents/create-fixture.yaml") {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: intent
  });
}

function withRecomputedPlanDigest(planValue) {
  const { planDigest: _ignored, ...body } = planValue;
  return { ...body, planDigest: sha256Json(body) };
}

async function terminateAtCrashPoint(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    let terminationRequested = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (
        !terminationRequested &&
        output.includes("FOUNDATION_CRASH_POINT")
      ) {
        terminationRequested = child.kill("SIGKILL");
        if (!terminationRequested) {
          reject(new Error("Failed to terminate the crash worker."));
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (!terminationRequested) {
        reject(
          new Error(
            `Crash worker exited before the fault point: code=${String(code)} signal=${String(signal)} ${stderr}`
          )
        );
        return;
      }
      resolve();
    });
  });
}

async function crashDuringApply(root, scaffoldPlan, phase, operationIndex) {
  const planPath = join(root, "crash-plan.json");
  await writeFile(planPath, `${JSON.stringify(scaffoldPlan, null, 2)}\n`);
  const child = spawn(
    process.execPath,
    [
      crashWorkerPath,
      filesystemWorkspaceModulePath,
      root,
      planPath,
      phase,
      ...(operationIndex === undefined ? [] : [String(operationIndex)])
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  await terminateAtCrashPoint(child);
  await utimes(
    join(root, ".agent-teams-local", "foundation-operation.lock"),
    new Date(0),
    new Date(0)
  );
}

test("compiles the same semantic Intent to one deterministic Plan", async () => {
  const root = await createConsumer();
  try {
    const first = await plan(root, "intents/facets-forward.yaml");
    const second = await plan(root, "intents/facets-reversed.yaml");
    assert.equal(first.planDigest, second.planDigest);
    assert.equal(first.intentDigest, second.intentDigest);
    assert.deepEqual(first, await plan(root, "intents/facets-forward.yaml"));
    assert.deepEqual(
      first.composition.facets.map(({ id }) => id),
      ["foundation.fixture-readme", "foundation.typecheck-fixture"]
    );
    assert.equal((await applyFilesystemScaffold(root, first)).outcome, "applied");
    const typecheck = spawnSync(
      process.execPath,
      [
        typescriptCliPath,
        "--project",
        join(root, "packages", "testing", "generated", "tsconfig.json"),
        "--pretty",
        "false"
      ],
      { encoding: "utf8" }
    );
    assert.equal(typecheck.status, 0, `${typecheck.stdout}${typecheck.stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves the published protocol v1 golden digests", async () => {
  const golden = JSON.parse(await readFile(goldenVectorPath, "utf8"));
  const input = await loadScaffoldCompilationInput({
    consumerRoot: fixtureRoot,
    configPath: golden.configPath,
    intentPath: golden.intentPath,
    foundationVersion: golden.foundationVersion
  });
  const scaffoldPlan = compileScaffoldPlan(
    input,
    new ScaffoldDefinitionRegistry(CONFORMANCE_FIXTURE_DEFINITIONS)
  );
  const receipt = await new MemoryScaffoldWorkspace().apply(scaffoldPlan);

  assert.deepEqual(
    {
      intentDigest: scaffoldPlan.intentDigest,
      authoritySnapshotDigest: scaffoldPlan.authoritySnapshotDigest,
      planDigest: scaffoldPlan.planDigest,
      receiptDigest: receipt.receiptDigest
    },
    {
      intentDigest: golden.intentDigest,
      authoritySnapshotDigest: golden.authoritySnapshotDigest,
      planDigest: golden.planDigest,
      receiptDigest: golden.receiptDigest
    }
  );
});

test("enforces definition-required policies even when the consumer adds none", async () => {
  const root = await createConsumer();
  try {
    const configPath = join(
      root,
      "architecture",
      "foundation",
      "scaffolding.yaml"
    );
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        /    policies:[\s\S]*?          allowedRoles: \[testing\]\n/u,
        "    policies: []\n"
      )
    );
    const scaffoldPlan = await plan(root);
    assert.deepEqual(
      scaffoldPlan.resolved.policies.map(({ ref, outcome }) => ({ ref, outcome })),
      [
        {
          ref: { id: "foundation.target-role", contractVersion: 1 },
          outcome: "passed"
        }
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces Facet requires and conflicts independently of selection order", async () => {
  const root = await createConsumer();
  try {
    const baseInput = await loadScaffoldCompilationInput({
      consumerRoot: root,
      configPath: "architecture/foundation/scaffolding.yaml",
      intentPath: "intents/create-fixture.yaml",
      foundationVersion: "1.0.0"
    });
    const requiredFacet = {
      kind: "facet",
      ref: { id: "foundation.fixture-requires-test", contractVersion: 1 },
      descriptor: {
        kind: "facet",
        semantics: "conformance-requires-test"
      },
      parameterSchema: { type: "object", additionalProperties: false },
      allowedRecipeIds: ["foundation.conformance-fixture-package"],
      requires: [{ id: "foundation.typecheck-fixture", contractVersion: 1 }],
      conflicts: [],
      requiredPolicies: [],
      compile: () => []
    };
    const conflictingFacet = {
      kind: "facet",
      ref: { id: "foundation.fixture-conflicts-readme", contractVersion: 1 },
      descriptor: {
        kind: "facet",
        semantics: "conformance-conflicts-readme"
      },
      parameterSchema: { type: "object", additionalProperties: false },
      allowedRecipeIds: ["foundation.conformance-fixture-package"],
      requires: [],
      conflicts: [
        { id: "foundation.fixture-readme", contractVersion: 1 }
      ],
      requiredPolicies: [],
      compile: () => []
    };
    const registry = new ScaffoldDefinitionRegistry([
      ...CONFORMANCE_FIXTURE_DEFINITIONS,
      requiredFacet,
      conflictingFacet
    ]);
    const config = structuredClone(baseInput.config);
    config.compositions[0].facets.allowed.push(
      requiredFacet.ref,
      conflictingFacet.ref
    );
    const input = (facets) => ({
      ...baseInput,
      config,
      intent: {
        ...baseInput.intent,
        facets: facets.map((ref) => ({ ref }))
      }
    });

    assert.throws(
      () => compileScaffoldPlan(input([requiredFacet.ref]), registry),
      /requires foundation.typecheck-fixture/u
    );
    assert.doesNotThrow(() =>
      compileScaffoldPlan(
        input([
          requiredFacet.ref,
          { id: "foundation.typecheck-fixture", contractVersion: 1 }
        ]),
        registry
      )
    );
    for (const facets of [
      [
        conflictingFacet.ref,
        { id: "foundation.fixture-readme", contractVersion: 1 }
      ],
      [
        { id: "foundation.fixture-readme", contractVersion: 1 },
        conflictingFacet.ref
      ]
    ]) {
      assert.throws(
        () => compileScaffoldPlan(input(facets), registry),
        /conflicts with foundation.fixture-readme/u
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown Intent fields and unapproved Facets", async () => {
  const root = await createConsumer();
  try {
    await writeFile(
      join(root, "intents", "unknown-field.yaml"),
      `${await readFile(join(root, "intents", "create-fixture.yaml"), "utf8")}template: forbidden\n`
    );
    await assert.rejects(
      plan(root, "intents/unknown-field.yaml"),
      /must NOT have additional properties/u
    );

    await writeFile(
      join(root, "intents", "unapproved-facet.yaml"),
      `schemaVersion: 1\ncompositionId: testing-package\ntargetRef: testing.generated\nrecipeParameters:\n  featureId: deterministic-fixture\nfacets:\n  - ref:\n      id: consumer.executable-plugin\n      contractVersion: 1\n`
    );
    await assert.rejects(
      plan(root, "intents/unapproved-facet.yaml"),
      /Facet is not allowed/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies a Plan atomically in memory and replays it as a no-op", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const workspace = new MemoryScaffoldWorkspace();
    const applied = await workspace.apply(scaffoldPlan);
    const replayed = await workspace.apply(scaffoldPlan);
    assert.equal(applied.outcome, "applied");
    assert.equal(replayed.outcome, "already-applied");
    assert.match(
      Buffer.from(
        workspace.read("packages/testing/generated/src/index.ts")
      ).toString("utf8"),
      /fixtureIdentity/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory Apply rejects unsupported adapter capabilities", async () => {
  const root = await createConsumer();
  try {
    const unsupported = structuredClone(await plan(root));
    unsupported.requiredAdapterCapabilities = ["consumer.exec-hook/v1"];
    const workspace = new MemoryScaffoldWorkspace();
    await assert.rejects(
      workspace.apply(withRecomputedPlanDigest(unsupported)),
      /requiredAdapterCapabilities|unsupported adapter capabilities/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory Apply rejects schema-forbidden Plan extensions", async () => {
  const root = await createConsumer();
  try {
    const extended = structuredClone(await plan(root));
    extended.consumerExtension = { executable: false };
    await assert.rejects(
      new MemoryScaffoldWorkspace().apply(withRecomputedPlanDigest(extended)),
      /additional properties/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a Plan whose content no longer matches its digest", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = structuredClone(await plan(root));
    scaffoldPlan.operations[0].after.contentBase64 = Buffer.from(
      "tampered\n"
    ).toString("base64");
    assert.throws(
      () => assertScaffoldPlanDigest(scaffoldPlan),
      /digest|content/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects self-consistent Plans that escape their target or duplicate outputs", async () => {
  const root = await createConsumer();
  try {
    const targetEscape = structuredClone(await plan(root));
    targetEscape.target.path = "packages/testing/other";
    await assert.rejects(
      applyFilesystemScaffold(root, withRecomputedPlanDigest(targetEscape)),
      /operation escapes target/u
    );

    const duplicateOutput = structuredClone(await plan(root));
    duplicateOutput.operations.push({
      ...structuredClone(duplicateOutput.operations[0]),
      id: "materialize/duplicate-output"
    });
    await assert.rejects(
      applyFilesystemScaffold(root, withRecomputedPlanDigest(duplicateOutput)),
      /identity or path is duplicated/u
    );

    const forgedAuthority = structuredClone(await plan(root));
    const originalTargetPath = forgedAuthority.target.path;
    forgedAuthority.target.path = "packages/testing/forged";
    forgedAuthority.operations = forgedAuthority.operations.map((operation) => ({
      ...operation,
      path: operation.path.replace(
        `${originalTargetPath}/`,
        `${forgedAuthority.target.path}/`
      )
    }));
    await assert.rejects(
      applyFilesystemScaffold(root, withRecomputedPlanDigest(forgedAuthority)),
      /not produced by the closed compiler/u
    );

    const forgedCompilerVersion = structuredClone(await plan(root));
    forgedCompilerVersion.compiler.version = "999.0.0";
    await assert.rejects(
      applyFilesystemScaffold(
        root,
        withRecomputedPlanDigest(forgedCompilerVersion)
      ),
      /not produced by the closed compiler/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a valid self-contained Plan larger than the config input limit", async () => {
  const root = await createConsumer();
  try {
    const largePlan = structuredClone(await plan(root));
    const content = Buffer.alloc(900_000, 0x61);
    largePlan.operations[0].after = {
      ...largePlan.operations[0].after,
      contentBase64: content.toString("base64"),
      digest: sha256Bytes(content),
      size: content.byteLength
    };
    const finalizedPlan = withRecomputedPlanDigest(largePlan);
    await mkdir(join(root, "plans"));
    const planPath = join(root, "plans", "large.json");
    await writeFile(planPath, `${JSON.stringify(finalizedPlan)}\n`);
    assert.ok((await stat(planPath)).size > 1024 * 1024);
    assert.equal(
      (await readScaffoldPlanFile(root, "plans/large.json")).planDigest,
      finalizedPlan.planDigest
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans and applies the conformance package through the CLI", async () => {
  const root = await createConsumer();
  try {
    const planned = spawnSync(
      process.execPath,
      [
        cliPath,
        "scaffold-plan",
        "intents/create-fixture.yaml",
        "--consumer",
        root,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(planned.status, 0, planned.stderr);
    const scaffoldPlan = JSON.parse(planned.stdout);
    await mkdir(join(root, "plans"));
    await writeFile(
      join(root, "plans", "fixture.json"),
      `${JSON.stringify(scaffoldPlan, null, 2)}\n`
    );

    const applied = spawnSync(
      process.execPath,
      [
        cliPath,
        "scaffold-apply",
        "plans/fixture.json",
        "--consumer",
        root,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).outcome, "applied");
    const replayed = spawnSync(
      process.execPath,
      [
        cliPath,
        "scaffold-apply",
        "plans/fixture.json",
        "--consumer",
        root,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(JSON.parse(replayed.stdout).outcome, "already-applied");

    const packageManifest = JSON.parse(
      await readFile(
        join(root, "packages", "testing", "generated", "package.json"),
        "utf8"
      )
    );
    assert.equal(packageManifest.name, "@fixture/generated");
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(
          join(root, "packages", "testing", "generated", "package.json")
        )).mode & 0o777,
        0o644
      );
    }
    assert.match(
      await readFile(
        join(
          root,
          "packages",
          "testing",
          "generated",
          "src",
          "features",
          "deterministic-fixture",
          "index.ts"
        ),
        "utf8"
      ),
      /deterministic-fixture/u
    );

    const typecheck = spawnSync(
      process.execPath,
      [
        typescriptCliPath,
        "--project",
        join(root, "packages", "testing", "generated", "tsconfig.json"),
        "--pretty",
        "false"
      ],
      { encoding: "utf8" }
    );
    assert.equal(typecheck.status, 0, `${typecheck.stdout}${typecheck.stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a stale authority snapshot before writing", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await writeFile(
      join(root, "architecture", "package-catalog.yaml"),
      `${await readFile(join(root, "architecture", "package-catalog.yaml"), "utf8")}\n`
    );
    const receipt = await applyFilesystemScaffold(root, scaffoldPlan);
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.diagnostics[0]?.ruleId, "scaffolding.apply.stale-authority-snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a pre-existing transaction temporary path", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const operation = scaffoldPlan.operations[0];
    const identity = sha256Text(
      `${scaffoldPlan.planDigest}:${operation.id}`
    ).slice("sha256:".length);
    const temporary = join(
      root,
      dirname(operation.path),
      `.foundation-${identity}.tmp`
    );
    await mkdir(dirname(temporary), { recursive: true });
    await writeFile(temporary, "user-owned sentinel\n");

    await assert.rejects(
      applyFilesystemScaffold(root, scaffoldPlan),
      /temporary path already exists/u
    );
    assert.equal(await readFile(temporary, "utf8"), "user-owned sentinel\n");
    await assert.rejects(
      stat(join(root, ".agent-teams-local", "scaffolding-transaction.json")),
      /ENOENT/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects third-state output without overwriting it", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const conflictPath = join(
      root,
      "packages",
      "testing",
      "generated",
      "src",
      "index.ts"
    );
    await mkdir(join(conflictPath, ".."), { recursive: true });
    await writeFile(conflictPath, "export const userOwned = true;\n");
    const receipt = await applyFilesystemScaffold(root, scaffoldPlan);
    assert.equal(receipt.outcome, "rejected");
    const conflictOperation = receipt.operations.find(
      ({ path }) => path === "packages/testing/generated/src/index.ts"
    );
    assert.equal(conflictOperation?.outcome, "conflict");
    assert.equal(conflictOperation?.resultDigest, undefined);
    assert.ok(
      receipt.operations.some(
        ({ outcome, resultDigest }) =>
          outcome === "not-applied" && resultDigest === undefined
      )
    );
    assert.equal(await readFile(conflictPath, "utf8"), "export const userOwned = true;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finishes a prepared transaction through deterministic recovery", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const firstPath = join(root, ...first.path.split("/"));
    await mkdir(join(firstPath, ".."), { recursive: true });
    await writeFile(firstPath, Buffer.from(first.after.contentBase64, "base64"));
    const stateRoot = join(root, ".agent-teams-local");
    await mkdir(stateRoot);
    await writeFile(
      join(stateRoot, "scaffolding-transaction.json"),
      `${JSON.stringify({ schemaVersion: 1, state: "PREPARED", plan: scaffoldPlan }, null, 2)}\n`
    );

    const receipt = await recoverFilesystemScaffold(root);
    assert.equal(receipt?.outcome, "failed-recovered");
    for (const operation of scaffoldPlan.operations) {
      assert.equal(
        (await readFile(join(root, ...operation.path.split("/")))).byteLength,
        operation.after.size
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a journal when recovery finds a third-state file", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const conflict = scaffoldPlan.operations[0];
    assert.ok(conflict);
    const conflictPath = join(root, ...conflict.path.split("/"));
    await mkdir(join(conflictPath, ".."), { recursive: true });
    await writeFile(conflictPath, "user-owned conflict\n");
    const journalPath = join(
      root,
      ".agent-teams-local",
      "scaffolding-transaction.json"
    );
    await mkdir(join(root, ".agent-teams-local"));
    await writeFile(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, state: "PREPARED", plan: scaffoldPlan }, null, 2)}\n`
    );

    const receipt = await recoverFilesystemScaffold(root);
    assert.equal(receipt?.outcome, "recovery-required");
    assert.match(await readFile(journalPath, "utf8"), /PREPARED/u);
    assert.equal(await readFile(conflictPath, "utf8"), "user-owned conflict\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers deterministically after process death at each publication phase", async () => {
  for (const scenario of [
    { phase: "after-journal-prepared" },
    { phase: "after-temporary-written", operationIndex: 0 },
    { phase: "after-temporary-synced", operationIndex: 0 },
    { phase: "after-hard-link", operationIndex: 0 },
    { phase: "after-operation-published", operationIndex: 0 },
    { phase: "before-journal-removed" }
  ]) {
    const root = await createConsumer();
    try {
      const scaffoldPlan = await plan(root);
      await crashDuringApply(
        root,
        scaffoldPlan,
        scenario.phase,
        scenario.operationIndex
      );
      const receipt = await recoverFilesystemScaffold(root);
      assert.equal(receipt?.outcome, "failed-recovered", scenario.phase);
      for (const operation of scaffoldPlan.operations) {
        assert.equal(
          (await readFile(join(root, ...operation.path.split("/")))).byteLength,
          operation.after.size,
          `${scenario.phase}: ${operation.path}`
        );
      }
      await assert.rejects(
        readFile(
          join(root, ".agent-teams-local", "scaffolding-transaction.json"),
          "utf8"
        ),
        /ENOENT/u
      );
      assert.equal(
        (await readdir(root, { recursive: true })).some((entry) =>
          entry.includes(".foundation-")
        ),
        false,
        `${scenario.phase}: orphan transaction temporary`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("fails closed when a target parent is a symbolic link", async () => {
  const root = await createConsumer();
  const outside = await mkdtemp(join(tmpdir(), "foundation-scaffolding-outside-"));
  try {
    const scaffoldPlan = await plan(root);
    await mkdir(join(root, "packages"));
    await symlink(outside, join(root, "packages", "testing"));
    await assert.rejects(
      applyFilesystemScaffold(root, scaffoldPlan),
      /not a real directory|escapes the repository/u
    );
    assert.deepEqual(await readdirSafe(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("fails before journaling when an existing path differs only by case", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await mkdir(join(root, "Packages"));
    await assert.rejects(
      applyFilesystemScaffold(root, scaffoldPlan),
      /case folding/u
    );
    await assert.rejects(
      readFile(
        join(root, ".agent-teams-local", "scaffolding-transaction.json"),
        "utf8"
      ),
      /ENOENT/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readdirSafe(path) {
  return readdir(path);
}
