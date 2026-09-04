import type { QualifiedDocsCohortBindingV2 } from "../domain/model.js";
import { qualifiedDocsCohortV2PackageEntries } from
  "../application/policies/qualified-docs-cohort-v2.js";
import { computePnpmRuntimeClosureDigestForTargets } from "./pnpm-runtime-closure-v1.js";

export function computePnpmRuntimeClosureDigestV2(
  lock: Record<string, unknown>,
  cohort: QualifiedDocsCohortBindingV2
): `sha256:${string}` {
  return computePnpmRuntimeClosureDigestForTargets(
    lock,
    qualifiedDocsCohortV2PackageEntries(cohort).map(({ name, version, integrity, direct }) => ({
      name,
      version,
      integrity,
      direct
    }))
  );
}
