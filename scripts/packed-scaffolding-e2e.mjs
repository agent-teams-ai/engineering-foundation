import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./pack-test-support.mjs";

async function runScaffoldingCommand(fixture, args) {
  const { stdout } = await runCommand(
    process.execPath,
    [fixture.toolEntrypoints.foundationCli, ...args],
    fixture.consumerRoot
  );
  return JSON.parse(stdout);
}

export async function verifyPackedScaffolding({ fixture, repositoryRoot }) {
  const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "scaffolding-consumer");
  await cp(
    join(fixtureRoot, "architecture", "foundation", "scaffolding.yaml"),
    join(fixture.consumerRoot, "architecture", "foundation", "scaffolding.yaml")
  );
  await cp(
    join(fixtureRoot, "architecture", "package-catalog.yaml"),
    join(fixture.consumerRoot, "architecture", "package-catalog.yaml")
  );
  await mkdir(join(fixture.consumerRoot, "intents"), { recursive: true });
  await cp(
    join(fixtureRoot, "intents", "create-fixture.yaml"),
    join(fixture.consumerRoot, "intents", "create-fixture.yaml")
  );

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
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8"
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
  const generatedManifest = JSON.parse(
    await readFile(
      join(fixture.consumerRoot, "packages", "testing", "generated", "package.json"),
      "utf8"
    )
  );
  if (generatedManifest.name !== "@fixture/generated") {
    throw new Error("Packed scaffolding CLI generated an unexpected package.");
  }
}
