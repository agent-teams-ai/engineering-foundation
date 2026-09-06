import {
  qualifiedDocsCohortV2PackageEntries,
  type QualifiedDocsCohortBindingV2
} from "../application-api.js";
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
