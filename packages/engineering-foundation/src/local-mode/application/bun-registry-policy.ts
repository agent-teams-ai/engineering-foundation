import { FOUNDATION_PACKAGE_NAME } from "./model.js";
import { isExactVersion } from "../../semantic-version.js";
import type { LockfileProvenanceInspection } from "./consumer-policy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function targetsFoundation(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((key) => key.includes(FOUNDATION_PACKAGE_NAME));
}

function inspectRoot(
  lockfile: Record<string, unknown>,
  dependencySpec: string | undefined,
  issues: string[],
): void {
  const root = isRecord(lockfile.workspaces) ? lockfile.workspaces[""] : undefined;
  if (
    !isRecord(root) ||
    !isRecord(root.devDependencies) ||
    dependencySpec === undefined ||
    !isExactVersion(dependencySpec) ||
    root.devDependencies[FOUNDATION_PACKAGE_NAME] !== dependencySpec
  ) {
    issues.push(
      "Consumer bun.lock root devDependency must equal the exact Foundation manifest version.",
    );
  }
  if (isRecord(root)) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (isRecord(root[field]) && root[field][FOUNDATION_PACKAGE_NAME] !== undefined) {
        issues.push(`Consumer bun.lock must not resolve Foundation through root ${field}.`);
      }
    }
  }
}

function inspectTuple(
  lockfile: Record<string, unknown>,
  tupleIdentity: string,
  issues: string[],
): string | undefined {
  const packages = isRecord(lockfile.packages) ? lockfile.packages : {};
  const tuple = packages[FOUNDATION_PACKAGE_NAME];
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 4 ||
    tuple[0] !== tupleIdentity ||
    tuple[1] !== "" ||
    !isRecord(tuple[2])
  ) {
    issues.push("Consumer bun.lock must contain one exact default npm registry Foundation tuple.");
  }
  for (const [key, candidate] of Object.entries(packages)) {
    if (
      key !== FOUNDATION_PACKAGE_NAME &&
      Array.isArray(candidate) &&
      typeof candidate[0] === "string" &&
      candidate[0].startsWith(`${FOUNDATION_PACKAGE_NAME}@`)
    ) {
      issues.push("Consumer bun.lock contains an ambiguous Foundation package tuple.");
    }
  }
  const integrity: unknown = Array.isArray(tuple) ? tuple[3] : undefined;
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/u.test(integrity)) {
    issues.push(
      "Consumer bun.lock Foundation tuple must contain canonical sha512 registry integrity.",
    );
  }
  return typeof integrity === "string" ? integrity : undefined;
}

/** Bun text-lock selection evidence; no installed mirror or archive authentication. */
export function inspectBunLockfile(
  lockfile: Record<string, unknown>,
  dependencySpec?: string,
): LockfileProvenanceInspection {
  const issues: string[] = [];
  if (lockfile.lockfileVersion !== 2 || lockfile.configVersion !== 1) {
    issues.push("Consumer bun.lock must use text lockfileVersion 2 and configVersion 1.");
  }
  for (const field of ["overrides", "resolutions", "patchedDependencies"]) {
    if (targetsFoundation(lockfile[field])) {
      issues.push(`Consumer bun.lock must not use Foundation ${field}.`);
    }
  }
  inspectRoot(lockfile, dependencySpec, issues);
  const tupleIdentity = `${FOUNDATION_PACKAGE_NAME}@${dependencySpec}`;
  const integrity = inspectTuple(lockfile, tupleIdentity, issues);
  return {
    ...(issues.length === 0 && typeof integrity === "string"
      ? { packageKey: FOUNDATION_PACKAGE_NAME, integrity }
      : {}),
    issues,
  };
}
