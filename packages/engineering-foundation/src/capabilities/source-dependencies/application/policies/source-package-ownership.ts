import { portablePathIsInside, portableRepositoryPathIdentity } from "../model/repository-path.js";

/** Module interpretation is independent of package dependency authority. */
export function isPureModuleTypeScope(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 1 &&
    (value["type"] === "module" || value["type"] === "commonjs");
}

export interface SourcePackageOwnership {
  readonly ownershipManifestPaths: readonly string[];
  readonly rootSourceRoots: readonly string[];
}

export function sourcePackageOwner<T extends { readonly manifestPath: string; readonly rootPath: string }>(
  path: string,
  packages: readonly T[],
  ownership: SourcePackageOwnership
): T | undefined {
  const owners = new Map(packages.map((owner) => [
    portableRepositoryPathIdentity(owner.rootPath), owner
  ]));
  const fences = new Set(ownership.ownershipManifestPaths.map((manifest) =>
    manifest === "package.json" ? "." : portableRepositoryPathIdentity(manifest.slice(0, -"/package.json".length))
  ));
  let candidate = portableRepositoryPathIdentity(path);
  for (;;) {
    if (fences.has(candidate)) {
      const owner = owners.get(candidate);
      return candidate === "." &&
        !ownership.rootSourceRoots.some((root) => portablePathIsInside(path, root))
        ? undefined : owner;
    }
    if (candidate === ".") {
      return undefined;
    }
    const separator = candidate.lastIndexOf("/");
    candidate = separator === -1 ? "." : candidate.slice(0, separator);
  }
}
