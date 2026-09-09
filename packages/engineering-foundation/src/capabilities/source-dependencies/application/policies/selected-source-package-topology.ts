import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { sourceTopologyInputError as inputError } from "./source-topology-evidence.js";
import type { WorkspacePackage } from "../model/workspace-inventory.js";
import { portableRepositoryPathIdentity } from "../model/repository-path.js";
import type { SourceWorkspacePackageTopology } from "../model/source-workspace-topology.js";

function packageByPortableRoot(
  packages: readonly WorkspacePackage[]
): ReadonlyMap<string, WorkspacePackage> {
  const byRoot = new Map<string, WorkspacePackage>();
  for (const workspacePackage of packages) {
    const identity = portableRepositoryPathIdentity(workspacePackage.rootPath);
    const existing = byRoot.get(identity);
    if (existing !== undefined) {
      inputError(
        "WORKSPACE_PACKAGE_ROOT_DUPLICATE",
        `Workspace package roots share a portable identity: ${existing.rootPath} and ${workspacePackage.rootPath}.`
      );
    }
    byRoot.set(identity, workspacePackage);
  }
  return byRoot;
}

function packageRootIdentities(
  manifestPaths: readonly string[]
): ReadonlySet<string> {
  return new Set(
    manifestPaths.map((manifestPath) =>
      portableRepositoryPathIdentity(
        manifestPath === "package.json" ? "." : manifestPath.slice(0, -"/package.json".length)
      )
    )
  );
}

function owningPackage(
  path: string,
  packagesByRoot: ReadonlyMap<string, WorkspacePackage>,
  ownershipRoots: ReadonlySet<string>
): WorkspacePackage | undefined {
  let candidate = portableRepositoryPathIdentity(path);
  for (;;) {
    if (ownershipRoots.has(candidate)) {
      return packagesByRoot.get(candidate);
    }
    if (candidate === ".") {
      return undefined;
    }
    const separator = candidate.lastIndexOf("/");
    candidate = separator === -1 ? "." : candidate.slice(0, separator);
  }
}

export function buildSelectedPackageSourceTopology(
  packages: readonly WorkspacePackage[],
  sourcePaths: readonly string[],
  allManifestPaths: readonly string[]
): readonly Omit<SourceWorkspacePackageTopology, "filesystemIdentity">[] {
  const packagesByRoot = packageByPortableRoot(packages);
  const ownershipRoots = packageRootIdentities(allManifestPaths);
  const pathsByRoot = new Map<string, string[]>();
  for (const workspacePackage of packages) {
    pathsByRoot.set(portableRepositoryPathIdentity(workspacePackage.rootPath), []);
  }
  for (const path of sourcePaths) {
    const workspacePackage = owningPackage(path, packagesByRoot, ownershipRoots);
    if (workspacePackage !== undefined) {
      pathsByRoot
        .get(portableRepositoryPathIdentity(workspacePackage.rootPath))
        ?.push(path);
    }
  }
  return Object.freeze(
    packages
      .toSorted((left, right) => compareBinaryStrings(left.rootPath, right.rootPath))
      .map((workspacePackage) =>
        Object.freeze({
          manifestPath: workspacePackage.manifestPath,
          name: workspacePackage.name,
          rootPath: workspacePackage.rootPath,
          sourcePaths: Object.freeze(
            (pathsByRoot.get(
              portableRepositoryPathIdentity(workspacePackage.rootPath)
            ) ?? []).toSorted(compareBinaryStrings)
          )
        })
      )
  );
}

export function rootOutsideSelectedPackages(
  repositoryPath: string,
  packages: readonly WorkspacePackage[],
  allManifestPaths: readonly string[]
): boolean {
  return (
    owningPackage(
      repositoryPath,
      packageByPortableRoot(packages),
      packageRootIdentities(allManifestPaths)
    ) === undefined
  );
}
