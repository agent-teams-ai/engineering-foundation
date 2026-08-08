import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./pack-test-support.mjs";

async function copyScaffoldingFixture(fixtureRoot, consumerRoot) {
  await mkdir(consumerRoot, { recursive: true });
  await cp(fixtureRoot, consumerRoot, { recursive: true });
}

async function runScaffoldingCommand(fixture, consumerRoot, arguments_) {
  const { stdout } = await runCommand(
    process.execPath,
    [fixture.toolEntrypoints.foundationCli, ...arguments_],
    consumerRoot
  );
  return JSON.parse(stdout);
}

async function verifyPackedLibraryRecipe(fixture, repositoryRoot) {
  const libraryFixtureRoot = join(
    repositoryRoot,
    "tests",
    "fixtures",
    "scaffolding-library-consumer"
  );
  const libraryRoot = join(fixture.consumerRoot, "library-consumer");
  await copyScaffoldingFixture(libraryFixtureRoot, libraryRoot);
  const libraryPlan = await runScaffoldingCommand(fixture, libraryRoot, [
    "scaffold-plan",
    "intents/create-beta.yaml",
    "--consumer",
    libraryRoot,
    "--json"
  ]);
  await mkdir(join(libraryRoot, "plans"), { recursive: true });
  await writeFile(
    join(libraryRoot, "plans", "library.json"),
    `${JSON.stringify(libraryPlan, null, 2)}\n`
  );
  const libraryReceipt = await runScaffoldingCommand(fixture, libraryRoot, [
    "scaffold-apply",
    "plans/library.json",
    "--consumer",
    libraryRoot,
    "--json"
  ]);
  if (libraryReceipt.outcome !== "applied") {
    throw new Error("Packed library recipe did not apply its reviewed Plan.");
  }
  const libraryManifest = JSON.parse(
    await readFile(
      join(libraryRoot, "packages", "deep", "nested", "beta", "package.json"),
      "utf8"
    )
  );
  if (
    libraryManifest.name !== "@fixture/beta-library" ||
    libraryManifest.agentTeamsArchitecture?.ownerDocument !== "OWNER-BETA"
  ) {
    throw new Error("Packed library recipe generated an unexpected boundary.");
  }
}

export async function verifyPackedAuthorityScaffolding({
  fixture,
  repositoryRoot
}) {
  const fixtureRoot = join(
    repositoryRoot,
    "tests",
    "fixtures",
    "scaffolding-authority-consumer"
  );
  const authorityRoot = join(fixture.consumerRoot, "authority-consumer");
  await copyScaffoldingFixture(fixtureRoot, authorityRoot);
  const plan = await runScaffoldingCommand(fixture, authorityRoot, [
    "scaffold-plan",
    "intents/create-fixture.yaml",
    "--consumer",
    authorityRoot,
    "--json"
  ]);
  await mkdir(join(authorityRoot, "plans"), { recursive: true });
  await writeFile(
    join(authorityRoot, "plans", "pack-fixture.json"),
    `${JSON.stringify(plan, null, 2)}\n`
  );
  const receipt = await runScaffoldingCommand(fixture, authorityRoot, [
    "scaffold-apply",
    "plans/pack-fixture.json",
    "--consumer",
    authorityRoot,
    "--json"
  ]);
  if (receipt.outcome !== "applied") {
    throw new Error("Packed scaffolding CLI did not apply its deterministic Plan.");
  }
  await writeFile(
    join(authorityRoot, "plans", "pack-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );

  const programmaticRoot = join(fixture.consumerRoot, "programmatic-consumer");
  const recoveryRoot = join(fixture.consumerRoot, "recovery-consumer");
  await copyScaffoldingFixture(fixtureRoot, programmaticRoot);
  await copyScaffoldingFixture(fixtureRoot, recoveryRoot);
  await writeFile(
    join(fixture.consumerRoot, "pack-scaffolding-consumer.mjs"),
    `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  readScaffoldPlanFile,
  recoverFilesystemScaffold,
  validateScaffoldReceipt
} from "@agent-teams/engineering-foundation/scaffolding";

const consumerRoot = process.cwd();
const authorityRoot = join(consumerRoot, "authority-consumer");
const expectedPlan = JSON.parse(await readFile(join(authorityRoot, "plans", "pack-fixture.json"), "utf8"));
const receipt = JSON.parse(await readFile(join(authorityRoot, "plans", "pack-receipt.json"), "utf8"));
const programmaticRoot = join(consumerRoot, "programmatic-consumer");
const recoveryRoot = join(consumerRoot, "recovery-consumer");
await validateScaffoldReceipt(receipt, expectedPlan);
const plan = await planScaffoldFromFile({ consumerRoot: programmaticRoot, intentPath: "intents/create-fixture.yaml" });
if (plan.planDigest !== expectedPlan.planDigest) process.exit(2);
await writeFile(join(programmaticRoot, "plan.json"), JSON.stringify(plan));
const persisted = await readScaffoldPlanFile(programmaticRoot, "plan.json");
if (persisted.planDigest !== plan.planDigest) process.exit(3);
const applied = await applyFilesystemScaffold(programmaticRoot, plan);
if (applied.outcome !== "applied") process.exit(4);
await validateScaffoldReceipt(applied, plan);
const repeated = await applyFilesystemScaffold(programmaticRoot, plan);
if (repeated.outcome !== "already-applied") process.exit(5);
if ((await recoverFilesystemScaffold(programmaticRoot)) !== undefined) process.exit(6);
const recoveryPlan = await planScaffoldFromFile({ consumerRoot: recoveryRoot, intentPath: "intents/create-fixture.yaml" });
const journalPath = join(recoveryRoot, ".agent-teams-local", "scaffolding-transaction.json");
await mkdir(join(recoveryRoot, ".agent-teams-local"), { recursive: true });
await writeFile(journalPath, JSON.stringify({
  schemaVersion: 1,
  state: "PREPARED",
  plan: recoveryPlan,
  operations: recoveryPlan.operations.map((operation) => ({ operationId: operation.id, path: operation.path, state: "pending" }))
}));
const recovered = await recoverFilesystemScaffold(recoveryRoot);
if (recovered?.outcome !== "failed-recovered") process.exit(7);
await validateScaffoldReceipt(recovered, recoveryPlan);
if ((await recoverFilesystemScaffold(recoveryRoot)) !== undefined) process.exit(8);
process.stdout.write(JSON.stringify({ outcome: "passed" }));
`
  );
  const { stdout: programmaticOutput } = await runCommand(
    process.execPath,
    [join(fixture.consumerRoot, "pack-scaffolding-consumer.mjs")],
    fixture.consumerRoot
  );
  if (JSON.parse(programmaticOutput).outcome !== "passed") {
    throw new Error("Packed ESM scaffolding API did not pass its consumer flow.");
  }
  const generatedManifest = JSON.parse(
    await readFile(
      join(
        authorityRoot,
        "packages",
        "testing",
        "generated",
        "package.json"
      ),
      "utf8"
    )
  );
  if (generatedManifest.name !== "@fixture/generated") {
    throw new Error("Packed scaffolding CLI generated an unexpected package.");
  }
  await verifyPackedLibraryRecipe(fixture, repositoryRoot);
}
