import type { QualificationEvidence } from "./package-artifact-custody.mts";
import { parsePackageQualificationGroupArguments } from "./package-qualification-groups.mts";
import { runPackTest } from "./pack-test.mjs";
import { runRegistryInstallTest } from "./registry-install-e2e.mjs";
import { preparePackages } from "./prepare-package.mjs";
import { runPublishablePackageChecks } from "./check-publishable-packages.mjs";

// Every call opens a fresh lifetime: all targets, two clean builds per target,
// and, in registry mode, a new registry/database/cache/config/token namespace.
export async function qualifyPackageGroup(args: readonly string[]): Promise<QualificationEvidence> {
  const request = parsePackageQualificationGroupArguments(args);
  await preparePackages();
  await runPublishablePackageChecks();
  return request.mode === "packed"
    ? runPackTest(request.group)
    : runRegistryInstallTest(request.group);
}

if (import.meta.main) {
  await qualifyPackageGroup(process.argv.slice(2));
}
