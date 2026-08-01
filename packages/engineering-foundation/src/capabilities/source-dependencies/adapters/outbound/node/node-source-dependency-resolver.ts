import { builtinModules } from "node:module";
import { posix } from "node:path";

import type {
  DependencyDeclaration,
  PackageExportEntry,
  WorkspacePackage
} from "../../../../../workspace-inventory/application/model/workspace-inventory.js";
import type {
  ResolvedSourceDependency
} from "../../../application/model/source-workspace.js";
import type {
  ResolveSourceDependencyInput,
  SourceDependencyResolver
} from "../../../application/ports/source-dependency-resolver.js";

const BUILTINS = new Set(
  builtinModules.flatMap((name) => [
    name,
    name.startsWith("node:") ? name.slice(5) : `node:${name}`
  ])
);
const SOURCE_EXTENSIONS = [
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
] as const;

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith("@")) {
    const segments = specifier.split("/");
    return segments.length >= 2 && segments[0] !== "" && segments[1] !== ""
      ? `${segments[0]}/${segments[1]}`
      : undefined;
  }
  const [name] = specifier.split("/");
  return name === undefined || name.length === 0 ? undefined : name;
}

function declarationKind(
  declarations: readonly DependencyDeclaration[],
  packageName: string
): "development" | "runtime" | "undeclared" {
  const matching = declarations.filter(
    (declaration) => declaration.dependencyName === packageName
  );
  if (
    matching.some(
      (declaration) =>
        declaration.section === "dependencies" ||
        declaration.section === "optionalDependencies" ||
        declaration.section === "peerDependencies"
    )
  ) {
    return "runtime";
  }
  return matching.some((declaration) => declaration.section === "devDependencies")
    ? "development"
    : "undeclared";
}

function candidateLocalPaths(importerPath: string, specifier: string): readonly string[] {
  const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  const extension = posix.extname(base);
  const candidates = new Set<string>([base]);
  if (extension === ".js") {
    candidates.add(`${base.slice(0, -3)}.ts`);
    candidates.add(`${base.slice(0, -3)}.tsx`);
  } else if (extension === ".mjs") {
    candidates.add(`${base.slice(0, -4)}.mts`);
  } else if (extension === ".cjs") {
    candidates.add(`${base.slice(0, -4)}.cts`);
  } else if (extension.length === 0) {
    for (const sourceExtension of SOURCE_EXTENSIONS) {
      candidates.add(`${base}${sourceExtension}`);
      candidates.add(posix.join(base, `index${sourceExtension}`));
    }
  }
  return [...candidates];
}

function pathInside(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function containingPackage(
  path: string,
  packages: readonly WorkspacePackage[]
): WorkspacePackage | undefined {
  return packages
    .filter((workspacePackage) => pathInside(path, workspacePackage.rootPath))
    .toSorted(
      (left, right) =>
        right.rootPath.length - left.rootPath.length ||
        left.name.localeCompare(right.name)
    )[0];
}

function matchesExport(entry: PackageExportEntry, subpath: string): boolean {
  if (!entry.subpath.includes("*")) {
    return entry.subpath === subpath;
  }
  const [prefix, suffix] = entry.subpath.split("*");
  return (
    prefix !== undefined &&
    suffix !== undefined &&
    subpath.startsWith(prefix) &&
    subpath.endsWith(suffix) &&
    subpath.length >= prefix.length + suffix.length
  );
}

function subpathExported(target: WorkspacePackage, subpath: string): boolean {
  if (!target.exportSurface.explicit) {
    return false;
  }
  const matching = target.exportSurface.entries
    .filter((entry) => matchesExport(entry, subpath))
    .toSorted((left, right) => {
      const leftExact = left.subpath.includes("*") ? 0 : 1;
      const rightExact = right.subpath.includes("*") ? 0 : 1;
      return rightExact - leftExact || right.subpath.length - left.subpath.length;
    });
  return matching[0]?.availability === "available";
}

function resolveLocal(input: ResolveSourceDependencyInput): ResolvedSourceDependency {
  if (input.reference.specifier.includes("?") || input.reference.specifier.includes("#")) {
    return {
      kind: "unsupported",
      reason: "relative specifiers with query strings or fragments are unsupported"
    };
  }
  const matching = candidateLocalPaths(
    input.file.path,
    input.reference.specifier
  ).filter((path) => input.governedFilePaths.has(path));
  if (matching.length !== 1) {
    return {
      kind: "unresolved",
      reason: `local reference resolved to ${matching.length} governed files`
    };
  }
  const path = matching[0];
  const workspacePackage =
    path === undefined
      ? undefined
      : containingPackage(path, input.inventory.packages);
  return path === undefined || workspacePackage === undefined
    ? { kind: "unresolved", reason: "local target has no workspace package" }
    : { kind: "local-file", path, workspacePackage };
}

function resolvePackage(input: ResolveSourceDependencyInput): ResolvedSourceDependency {
  const specifier = input.reference.specifier;
  if (BUILTINS.has(specifier)) {
    return {
      kind: "builtin",
      specifier: specifier.startsWith("node:") ? specifier : `node:${specifier}`
    };
  }
  if (specifier.startsWith("#") || specifier.startsWith("/") || specifier.includes(":")) {
    return { kind: "unsupported", reason: "unsupported package or URL specifier" };
  }
  const packageName = packageNameFromSpecifier(specifier);
  if (packageName === undefined) {
    return { kind: "unsupported", reason: "invalid package specifier" };
  }
  const target = input.inventory.packages.find(
    (workspacePackage) => workspacePackage.name === packageName
  );
  const declaration = declarationKind(
    input.file.workspacePackage.dependencies,
    packageName
  );
  if (target === undefined) {
    return { kind: "external-package", packageName, declaration };
  }
  const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  return {
    kind: "workspace-package",
    workspacePackage: target,
    declaration,
    exported: subpathExported(target, subpath),
    subpath
  };
}

export class NodeSourceDependencyResolver implements SourceDependencyResolver {
  resolve(input: ResolveSourceDependencyInput): ResolvedSourceDependency {
    return input.reference.specifier.startsWith(".")
      ? resolveLocal(input)
      : resolvePackage(input);
  }
}
