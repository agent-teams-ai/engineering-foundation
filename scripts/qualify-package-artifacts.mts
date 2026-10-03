import { withQualifiedPackageArtifacts } from "./pack-publishable-artifacts.mjs";
import { qualifyPackedConsumers } from "./pack-test.mjs";
import { qualifyRegistryConsumers } from "./registry-install-e2e.mjs";

// One fixed, sequential local composition. The owner produces two independent
// clean builds per target once and closes custody after both complete consumers.
export async function qualifyPackageArtifacts() {
  const evidence = await withQualifiedPackageArtifacts("combined", async handle => {
    await qualifyPackedConsumers(handle);
    await qualifyRegistryConsumers(handle);
  });
  process.stdout.write(`Combined package qualification PASS: ${JSON.stringify(evidence)}\n`);
  return evidence;
}

if (import.meta.main) {
  if (process.argv.length !== 2) { throw new Error("Combined qualification accepts no archive overrides or arguments."); }
  await qualifyPackageArtifacts();
}
