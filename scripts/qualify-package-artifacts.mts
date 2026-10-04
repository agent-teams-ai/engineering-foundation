import { withQualifiedPackageArtifacts } from "./pack-publishable-artifacts.mjs";
import { qualifyPackedConsumers } from "./pack-test.mjs";
import { qualifyRegistryConsumers } from "./registry-install-e2e.mjs";
import { combinedPackageQualificationGroups, parseCombinedQualificationArguments } from "./package-qualification-groups.mts";

// One fixed, sequential local composition. The owner produces two independent
// clean builds per target once and closes custody after both complete consumers.
export async function qualifyPackageArtifacts(profile?: unknown) {
  const groups = combinedPackageQualificationGroups(profile);
  const evidence = await withQualifiedPackageArtifacts("combined", async handle => {
    await qualifyPackedConsumers(handle, groups.packed);
    await qualifyRegistryConsumers(handle, groups.registry);
  });
  process.stdout.write(`Combined package qualification PASS: ${JSON.stringify(evidence)}\n`);
  return evidence;
}

if (import.meta.main) {
  await qualifyPackageArtifacts(parseCombinedQualificationArguments(process.argv.slice(2)));
}
