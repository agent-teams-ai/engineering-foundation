import { subpathExported } from "../../../application/policies/source-package-exports.js";
import { builtinModules } from "node:module";
import { posix } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import type {
  DependencyDeclaration,
  WorkspacePackage
} from "../../../application/model/workspace-inventory.js";
import type {
  ResolveSourceDependencyInput,
  SourceDependencyResolver
} from "../../../application/ports/source-dependency-resolver.js";
import type {
  ResolvedSourceDependency
} from "../../../application/model/source-workspace.js";
import {
  normalizeRepositoryPath,
  pathIsInside,
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../../../application/model/repository-path.js";

import { generatedOutputFilesystemIsSafe } from "./generated-output-filesystem.js";

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

function packageSpecifierHasTraversal(specifier: string): boolean {
  if (specifier.includes("\\") || /%2f|%5c/iu.test(specifier)) {
    return true;
  }
  const segments = specifier.split("/");
  const subpathStart = specifier.startsWith("@") ? 2 : 1;
  if (segments.length < subpathStart) {
    return true;
  }
  return segments.slice(subpathStart).some((segment) => {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return true;
    }
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    } catch {
      return true;
    }
  });
}

function isWorkspaceBinding(specifier: string): boolean {
  const value = specifier.slice("workspace:".length);
  return specifier.startsWith("workspace:") &&
    /^(?:[*^~]|[~^]?(?:0|[1-9][0-9]*)(?:[.](?:0|[1-9][0-9]*|[xX*])){0,2}(?:-[0-9A-Za-z]+(?:[.][0-9A-Za-z]+)*)?(?:[+][0-9A-Za-z]+(?:[.][0-9A-Za-z]+)*)?)$/u.test(value);
}

function declarationKindV1(
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

function declarationKind(
  declarations: readonly DependencyDeclaration[],
  packageName: string
): "development" | "runtime" | "undeclared" {
  const matching = declarations.filter(
    (declaration) => declaration.dependencyName === packageName
  );
  if (matching.length === 0 || matching.some(({ specifier }) => !isWorkspaceBinding(specifier))) {
    return "undeclared";
  }
  return declarationKindV1(matching, packageName);
}

function catalogTarget(
  specifier: string,
  packageName: string,
  inventory: ResolveSourceDependencyInput["inventory"]
): string | undefined {
  if (!specifier.startsWith("catalog:")) {
    return undefined;
  }
  const catalogName = specifier.slice("catalog:".length) || "default";
  return inventory.catalogs.find(
    (entry) =>
      entry.catalogName === catalogName && entry.dependencyName === packageName
  )?.version;
}

function isLocalIdentitySpecifier(
  specifier: string,
  packageName: string,
  inventory: ResolveSourceDependencyInput["inventory"]
): boolean {
  const effective = catalogTarget(specifier, packageName, inventory) ?? specifier;
  return /^(?:workspace|link|file):/u.test(effective);
}

function externalDeclarationKind(
  declarations: readonly DependencyDeclaration[],
  packageName: string,
  inventory: ResolveSourceDependencyInput["inventory"]
): "development" | "runtime" | "undeclared" {
  const matching = declarations.filter(
    (declaration) => declaration.dependencyName === packageName
  );
  return matching.some(({ specifier }) =>
    isLocalIdentitySpecifier(specifier, packageName, inventory)
  )
    ? "undeclared"
    : declarationKindV1(matching, packageName);
}

function candidateLocalPaths(importerPath: string, specifier: string): readonly string[] {
  const base = posix.normalize(
    posix.join(posix.dirname(normalizeRepositoryPath(importerPath)), specifier)
  );
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
  return pathIsInside(path, root);
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
        compareBinaryStrings(left.name, right.name)
    )[0];
}


function generatedOutputLiteral(raw: string): readonly string[] | undefined {
  if (
    raw.includes("\\") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("%")
  ) {
    return undefined;
  }
  const segments = raw.split("/");
  let index = 0;
  while (segments[index] === "." || segments[index] === "..") {
    index += 1;
  }
  const output = segments.slice(index);
  if (
    index === 0 ||
    output[0] !== "dist" ||
    output.length < 2 ||
    output.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    ) ||
    output.some(
      (segment) =>
        portableRepositoryPathProblem(segment) !== undefined ||
        portableRepositoryPathIdentity(segment) !==
          segment.toLocaleLowerCase("en-US")
    ) ||
    !/[.]((?:m|c)?js)$/u.test(output.at(-1) ?? "")
  ) {
    return undefined;
  }
  return output;
}

function generatedOutputCandidate(
  input: ResolveSourceDependencyInput
): ResolvedSourceDependency | undefined {
  const raw = input.reference.specifier;
  if (generatedOutputLiteral(raw) === undefined) {
    return undefined;
  }
  const targetPath = normalizeRepositoryPath(posix.join(posix.dirname(input.file.path), raw));
  const expectedDist = posix.join(input.file.workspacePackage.rootPath, "dist");
  if (!pathInside(targetPath, expectedDist) || targetPath === expectedDist) {
    return undefined;
  }
  const owner = containingPackage(targetPath, input.inventory.packages);
  if (
    owner?.name !== input.file.workspacePackage.name ||
    owner.manifestPath !== input.file.workspacePackage.manifestPath ||
    !generatedOutputFilesystemIsSafe({
      consumerRoot: input.consumerRoot,
      ...(input.consumerRootIdentity === undefined
        ? {}
        : { expectedRootIdentity: input.consumerRootIdentity }),
      ...(input.workspacePackageRootIdentity === undefined
        ? {}
        : { expectedPackageRootIdentity: input.workspacePackageRootIdentity }),
      packageRoot: owner.rootPath,
      target: targetPath
    })
  ) {
    return undefined;
  }
  return {
    kind: "generated-output-candidate",
    path: targetPath,
    workspacePackage: owner
  };
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
  ).filter((path) => input.governedFilePaths.has(normalizeRepositoryPath(path)));
  if (matching.length !== 1) {
    return {
      kind: "unresolved",
      reason: `local reference resolved to ${matching.length} governed files`
    };
  }
  const path = matching[0] === undefined ? undefined : normalizeRepositoryPath(matching[0]);
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
  if (packageSpecifierHasTraversal(specifier)) {
    return { kind: "unsupported", reason: "package specifier traversal is unsupported" };
  }
  const packageName = packageNameFromSpecifier(specifier);
  if (packageName === undefined) {
    return { kind: "unsupported", reason: "invalid package specifier" };
  }
  const inventoryTarget = input.inventory.packages.find(
    (workspacePackage) => workspacePackage.name === packageName
  );
  const target =
    input.enforceWorkspaceBindings === true &&
    inventoryTarget !== undefined &&
    input.governedWorkspacePackageManifestPaths !== undefined &&
    !input.governedWorkspacePackageManifestPaths.has(inventoryTarget.manifestPath)
      ? undefined
      : inventoryTarget;
  const declaration = input.enforceWorkspaceBindings === true
    ? target === undefined
      ? inventoryTarget === undefined
        ? externalDeclarationKind(
            input.file.workspacePackage.dependencies,
            packageName,
            input.inventory
          )
        : declarationKind(
            input.file.workspacePackage.dependencies,
            packageName
          )
      : declarationKind(input.file.workspacePackage.dependencies, packageName)
    : declarationKindV1(input.file.workspacePackage.dependencies, packageName);
  if (target === undefined) {
    return { kind: "external-package", packageName, declaration };
  }
  const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  if (target.name === input.file.workspacePackage.name) {
    return {
      kind: "self-workspace-package",
      workspacePackage: target,
      exported: subpathExported({
        importer: input.file.workspacePackage,
        importerPath: input.file.path,
        packageTypeScopes: input.packageTypeScopes,
        reference: input.reference,
        subpath,
        target
      }),
      subpath
    };
  }
  return {
    kind: "workspace-package",
    workspacePackage: target,
    declaration,
    exported: subpathExported({
      importer: input.file.workspacePackage,
      importerPath: input.file.path,
      packageTypeScopes: input.packageTypeScopes,
      reference: input.reference,
      subpath,
      target
    }),
    subpath
  };
}

export class NodeSourceDependencyResolver implements SourceDependencyResolver {
  resolve(input: ResolveSourceDependencyInput): ResolvedSourceDependency {
    if (!input.reference.specifier.startsWith(".")) {
      return resolvePackage(input);
    }
    const resolved = resolveLocal(input);
    return resolved.kind === "unresolved"
      ? generatedOutputCandidate(input) ?? resolved
      : resolved;
  }
}
