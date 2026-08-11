import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  recoverFilesystemScaffold,
  validateScaffoldReceipt,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { FOUNDATION_SCHEMA_IDS } from "../packages/engineering-foundation/dist/schema-ids.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
);
const cliPath = join(packageRoot, "dist", "cli.js");
const vector = JSON.parse(
  await readFile(
    join(repositoryRoot, "tests", "fixtures", "scaffolding-golden-vector-v1.json"),
    "utf8",
  ),
);
const sourceFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  vector.fixture,
);

async function withFixture(run) {
  const root = await mkdtemp(
    join(tmpdir(), "foundation-scaffolding-frozen-baseline-"),
  );
  try {
    await cp(sourceFixtureRoot, root, { recursive: true });
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function projectPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    protocolVersion: plan.protocolVersion,
    compiler: plan.compiler,
    projectId: plan.projectId,
    compositionId: plan.composition.id,
    intentDigest: plan.intentDigest,
    authoritySnapshotDigest: plan.authoritySnapshotDigest,
    planDigest: plan.planDigest,
    target: plan.target,
    definitions: plan.definitions.map((definition) => ({
      kind: definition.kind,
      id: definition.ref.id,
      contractVersion: definition.ref.contractVersion,
      contractDigest: definition.contractDigest,
    })),
    readSet: plan.readSet,
    requiredAdapterCapabilities: plan.requiredAdapterCapabilities,
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      path: operation.path,
      digest: operation.after.digest,
      size: operation.after.size,
      mode: operation.after.mode,
      mediaType: operation.after.mediaType,
      causes: operation.causes,
    })),
    diagnostics: plan.diagnostics,
  };
}

function projectReceipt(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    protocolVersion: receipt.protocolVersion,
    planDigest: receipt.planDigest,
    adapter: receipt.adapter,
    outcome: receipt.outcome,
    commit: receipt.commit,
    operationOutcomes: receipt.operations.map(({ outcome }) => outcome),
    diagnostics: receipt.diagnostics,
    receiptDigest: receipt.receiptDigest,
  };
}

async function schemaFilesBelow(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await schemaFilesBelow(filePath));
    } else if (entry.isFile() && filePath.endsWith(".schema.json")) {
      output.push(relative(packageRoot, filePath).replaceAll("\\", "/"));
    }
  }
  return output.toSorted();
}

test("freezes the current ScaffoldPlan and ScaffoldReceipt vectors", async () => {
  await withFixture(async (root) => {
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: vector.intentPath,
    });
    assert.deepEqual(projectPlan(plan), vector.plan);

    const receipt = await applyFilesystemScaffold(root, plan);
    assert.equal(await validateScaffoldReceipt(receipt, plan), receipt);
    assert.deepEqual(projectReceipt(receipt), vector.receipt);
  });
});

test("recovers the frozen legacy PREPARED journal shape", async () => {
  await withFixture(async (root) => {
    const plan = await planScaffoldFromFile({
      consumerRoot: root,
      intentPath: vector.intentPath,
    });
    const journal = {
      schemaVersion: vector.legacyJournal.schemaVersion,
      state: vector.legacyJournal.state,
      plan,
      operations: plan.operations.map((operation) => ({
        operationId: operation.id,
        path: operation.path,
        state: vector.legacyJournal.operationState,
      })),
    };
    const journalDirectory = join(root, ".agent-teams-local");
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(
      join(journalDirectory, "scaffolding-transaction.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
      "utf8",
    );

    const recovered = await recoverFilesystemScaffold(root);
    assert.ok(recovered);
    assert.equal(await validateScaffoldReceipt(recovered, plan), recovered);
    assert.deepEqual(
      {
        outcome: recovered.outcome,
        commit: recovered.commit,
        operationOutcome: new Set(
          recovered.operations.map(({ outcome }) => outcome),
        ).values().next().value,
      },
      vector.legacyJournal.expectedRecovery,
    );
    assert.equal(
      new Set(recovered.operations.map(({ outcome }) => outcome)).size,
      1,
    );
    assert.equal(await recoverFilesystemScaffold(root), undefined);
  });
});

test("freezes scaffolding CLI error and empty-recovery exit codes", async () => {
  for (const cliCase of vector.cli.invalid) {
    const result = spawnSync(process.execPath, [cliPath, ...cliCase.args], {
      encoding: "utf8",
    });
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      { status: cliCase.exitCode, stdout: "", stderr: cliCase.stderr },
    );
  }

  await withFixture(async (root) => {
    const result = spawnSync(
      process.execPath,
      [cliPath, "scaffold-recover", "--consumer", root, "--json"],
      { encoding: "utf8" },
    );
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      {
        status: vector.cli.noPendingRecovery.exitCode,
        stdout: vector.cli.noPendingRecovery.stdout,
        stderr: vector.cli.noPendingRecovery.stderr,
      },
    );
  });
});

test("freezes the released public API and package export map", async () => {
  const baselineBytes = await readFile(
    join(repositoryRoot, "architecture", "public-api", "engineering-foundation.json"),
  );
  const baseline = JSON.parse(baselineBytes);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(
    createHash("sha256").update(baselineBytes).digest("hex"),
    vector.publicApi.sha256,
  );
  assert.equal(baseline.packageVersion, vector.publicApi.packageVersion);
  assert.deepEqual(
    baseline.entrypoints.map((entrypoint) => ({
      exportPath: entrypoint.exportPath,
      itemCount: entrypoint.items.length,
    })),
    vector.publicApi.entrypoints,
  );
  assert.deepEqual(manifest.exports, vector.publicApi.exports);
});

test("freezes the runtime, filesystem, and published schema allowlists", async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const runtimeSchemaFiles = FOUNDATION_SCHEMA_IDS.map(
    (schemaId) => `schemas/${schemaId}.schema.json`,
  ).toSorted();
  const publishedSchemaFiles = manifest.files
    .filter((filePath) => filePath.startsWith("schemas/"))
    .toSorted();
  assert.deepEqual(runtimeSchemaFiles, vector.schemaFiles);
  assert.deepEqual(
    await schemaFilesBelow(join(packageRoot, "schemas")),
    vector.schemaFiles,
  );
  assert.deepEqual(publishedSchemaFiles, vector.schemaFiles);
});

test("keeps packed and registry-install qualification wired", async () => {
  const repositoryManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    repositoryManifest.scripts["package:check:built"],
    vector.packedE2e.packageCheckBuilt,
  );
  assert.equal(
    repositoryManifest.scripts["registry-install-e2e:built"],
    vector.packedE2e.registryInstallBuilt,
  );
  assert.match(
    await readFile(join(repositoryRoot, "scripts", "pack-test.mjs"), "utf8"),
    /verifyPackedAuthorityScaffolding/u,
  );
  assert.match(
    await readFile(
      join(repositoryRoot, "scripts", "registry-install-e2e.mjs"),
      "utf8",
    ),
    /\$\{FOUNDATION_PACKAGE_NAME\}\/scaffolding/u,
  );
});
