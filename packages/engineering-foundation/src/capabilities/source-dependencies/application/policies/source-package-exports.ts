import { posix } from "node:path";
import { resolvePackageExport } from "../../../../workspace-inventory/api.js";
import type { WorkspacePackage } from "../model/workspace-inventory.js";
import type { ResolveSourceDependencyInput } from "../ports/source-dependency-resolver.js";
import { pathIsInside as pathInside } from "../model/repository-path.js";

function nearestPackageType(input: {
  readonly importer: WorkspacePackage;
  readonly importerPath: string;
  readonly packageTypeScopes: ResolveSourceDependencyInput["packageTypeScopes"];
}): "commonjs" | "module" {
  return (input.packageTypeScopes ?? [])
    .filter(
      (scope) =>
        pathInside(scope.rootPath, input.importer.rootPath) &&
        pathInside(input.importerPath, scope.rootPath)
    )
    .toSorted((left, right) => right.rootPath.length - left.rootPath.length)[0]
    ?.moduleType ?? input.importer.moduleType;
}

function importerUsesCommonJs(
  importerPath: string,
  moduleType: "commonjs" | "module"
): boolean {
  const extension = posix.extname(importerPath).toLocaleLowerCase("en-US");
  return (
    extension === ".cts" ||
    extension === ".cjs" ||
    ((extension === ".ts" ||
      extension === ".tsx" ||
      extension === ".js" ||
      extension === ".jsx") &&
      moduleType === "commonjs")
  );
}

export function subpathExported(input: {
  readonly importer: WorkspacePackage;
  readonly importerPath: string;
  readonly packageTypeScopes: ResolveSourceDependencyInput["packageTypeScopes"];
  readonly reference: ResolveSourceDependencyInput["reference"];
  readonly subpath: string;
  readonly target: WorkspacePackage;
}): boolean {
  if (!input.target.exportSurface.explicit) {
    return false;
  }
  const staticLike =
    input.reference.kind === "static" ||
    input.reference.kind === "static-type" ||
    input.reference.kind === "export" ||
    input.reference.kind === "export-type" ||
    input.reference.kind === "type-query";
  const condition =
    input.reference.kind === "commonjs" ||
    input.reference.kind.startsWith("import-equals") ||
    (staticLike && importerUsesCommonJs(
      input.importerPath,
      nearestPackageType(input)
    ))
    ? "require"
    : "import";
  const typeOnly =
    input.reference.kind === "static-type" ||
    input.reference.kind === "export-type" ||
    input.reference.kind === "import-equals-type" ||
    input.reference.kind === "type-query";
  return resolvePackageExport(
    input.target.exportSurface.entries,
    input.subpath,
    condition,
    typeOnly
  ).available;
}
