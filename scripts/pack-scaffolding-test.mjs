import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./pack-test-support.mjs";

async function copyScaffoldingFixture(fixtureRoot, consumerRoot) {
  await mkdir(join(consumerRoot, "architecture", "foundation"), {
    recursive: true
  });
  await mkdir(join(consumerRoot, "docs", "decisions"), { recursive: true });
  await mkdir(join(consumerRoot, "intents"), { recursive: true });
  await cp(
    join(fixtureRoot, "architecture", "foundation", "scaffolding.yaml"),
    join(consumerRoot, "architecture", "foundation", "scaffolding.yaml")
  );
  await cp(
    join(fixtureRoot, "architecture", "package-catalog.yaml"),
    join(consumerRoot, "architecture", "package-catalog.yaml")
  );
  await cp(
    join(fixtureRoot, "docs", "decisions", "adr-0060.md"),
    join(consumerRoot, "docs", "decisions", "adr-0060.md")
  );
  await cp(
    join(fixtureRoot, "intents", "create-fixture.yaml"),
    join(consumerRoot, "intents", "create-fixture.yaml")
  );
}

async function runScaffoldingCommand(fixture, arguments_) {
  const { stdout } = await runCommand(
    process.execPath,
    [fixture.toolEntrypoints.foundationCli, ...arguments_],
    fixture.consumerRoot
  );
  return JSON.parse(stdout);
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
  await copyScaffoldingFixture(fixtureRoot, fixture.consumerRoot);
  const plan = await runScaffoldingCommand(fixture, [
    "scaffold-plan",
    "intents/create-fixture.yaml",
    "--consumer",
    fixture.consumerRoot,
    "--json"
  ]);
  await mkdir(join(fixture.consumerRoot, "plans"), { recursive: true });
  await writeFile(
    join(fixture.consumerRoot, "plans", "pack-fixture.json"),
    `${JSON.stringify(plan, null, 2)}\n`
  );
  const receipt = await runScaffoldingCommand(fixture, [
    "scaffold-apply",
    "plans/pack-fixture.json",
    "--consumer",
    fixture.consumerRoot,
    "--json"
  ]);
  if (receipt.outcome !== "applied") {
    throw new Error("Packed scaffolding CLI did not apply its deterministic Plan.");
  }
  await writeFile(
    join(fixture.consumerRoot, "plans", "pack-receipt.json"),
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
const expectedPlan = JSON.parse(await readFile("plans/pack-fixture.json", "utf8"));
const receipt = JSON.parse(await readFile("plans/pack-receipt.json", "utf8"));
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
  schemaVersion: 2,
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
        fixture.consumerRoot,
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
}
