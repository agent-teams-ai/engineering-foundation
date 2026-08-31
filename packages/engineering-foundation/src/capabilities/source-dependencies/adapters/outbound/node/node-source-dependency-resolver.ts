import { lstatSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative, sep } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import type {
  DependencyDeclaration,
  WorkspacePackage
} from "../../../../../workspace-inventory/application/model/workspace-inventory.js";
import { resolvePackageExport } from "../../../../../workspace-inventory/application/policies/package-export-matcher.js";
import type {
  ResolvedSourceDependency
} from "../../../application/model/source-workspace.js";
import {
  normalizeRepositoryPath,
  pathIsInside,
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../../../application/model/repository-path.js";
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

function subpathExported(
  target: WorkspacePackage,
  subpath: string,
  reference: ResolveSourceDependencyInput["reference"],
  importer: WorkspacePackage,
  importerPath: string
): boolean {
  if (!target.exportSurface.explicit) {
    return false;
  }
  const extension = posix.extname(importerPath).toLocaleLowerCase("en-US");
  const importerCommonJs =
    extension === ".cts" ||
    extension === ".cjs" ||
    ((extension === ".ts" ||
      extension === ".tsx" ||
      extension === ".js" ||
      extension === ".jsx") &&
      (importer.moduleType ?? "commonjs") === "commonjs");
  const staticLike =
    reference.kind === "static" ||
    reference.kind === "static-type" ||
    reference.kind === "export" ||
    reference.kind === "export-type" ||
    reference.kind === "type-query";
  const condition =
    reference.kind === "commonjs" ||
    reference.kind.startsWith("import-equals") ||
    (staticLike && importerCommonJs)
    ? "require"
    : "import";
  const typeOnly =
    reference.kind === "static-type" ||
    reference.kind === "export-type" ||
    reference.kind === "import-equals-type" ||
    reference.kind === "type-query";
  return resolvePackageExport(
    target.exportSurface.entries,
    subpath,
    condition,
    typeOnly
  ).available;
}

interface GeneratedConsumerRootSnapshot {
  readonly canonicalRoot: string;
  readonly device: string;
  readonly inode: string;
}

function generatedConsumerRootSnapshot(
  consumerRoot: string,
  expected: ResolveSourceDependencyInput["consumerRootIdentity"]
): GeneratedConsumerRootSnapshot | undefined {
  try {
    const canonicalRoot = realpathSync(consumerRoot);
    const metadata = lstatSync(canonicalRoot);
    const snapshot = {
      canonicalRoot,
      device: String(metadata.dev),
      inode: String(metadata.ino)
    };
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (expected !== undefined &&
        (snapshot.device !== expected.device || snapshot.inode !== expected.inode))
    ) {
      return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function generatedConsumerRootIsStable(
  snapshot: GeneratedConsumerRootSnapshot
): boolean {
  try {
    const metadata = lstatSync(snapshot.canonicalRoot);
    return String(metadata.dev) === snapshot.device &&
      String(metadata.ino) === snapshot.inode;
  } catch {
    return false;
  }
}

function safeExistingPackageAncestors(
  canonicalRoot: string,
  packageRoot: string
): boolean {
  let current = canonicalRoot;
  for (const segment of packageRoot.split("/").filter((value) => value !== ".")) {
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      const canonical = realpathSync(current);
      const containment = relative(canonicalRoot, canonical);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        containment === ".." ||
        containment.startsWith(`..${sep}`)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function safeExistingGeneratedAncestors(
  consumerRoot: string,
  expectedRootIdentity: ResolveSourceDependencyInput["consumerRootIdentity"],
  packageRoot: string,
  target: string
): boolean {
  const root = generatedConsumerRootSnapshot(consumerRoot, expectedRootIdentity);
  if (
    root === undefined ||
    !safeExistingPackageAncestors(root.canonicalRoot, packageRoot)
  ) {
    return false;
  }
  const { canonicalRoot } = root;
  const absolutePackage = join(canonicalRoot, ...packageRoot.split("/"));
  const absoluteDist = join(absolutePackage, "dist");
  const absoluteTarget = join(canonicalRoot, ...target.split("/"));
  const relation = relative(absoluteDist, absoluteTarget);
  let current = absoluteDist;
  for (const segment of ["", ...relation.split(sep).filter(Boolean)]) {
    current = segment === "" ? current : join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        return false;
      }
      const terminal = current === absoluteTarget;
      if ((terminal && !metadata.isFile()) || (!terminal && !metadata.isDirectory())) {
        return false;
      }
      const canonical = realpathSync(current);
      const containment = relative(absoluteDist, canonical);
      if (containment === ".." || containment.startsWith(`..${sep}`)) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" &&
          (error as NodeJS.ErrnoException).syscall?.includes("realpath") !== true) {
        return generatedConsumerRootIsStable(root);
      }
      return false;
    }
  }
  return generatedConsumerRootIsStable(root);
}

function generatedOutputCandidate(
  input: ResolveSourceDependencyInput
): ResolvedSourceDependency | undefined {
  const raw = input.reference.specifier;
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
  const targetPath = normalizeRepositoryPath(posix.join(posix.dirname(input.file.path), raw));
  const expectedDist = posix.join(input.file.workspacePackage.rootPath, "dist");
  if (!pathInside(targetPath, expectedDist) || targetPath === expectedDist) {
    return undefined;
  }
  const owner = containingPackage(targetPath, input.inventory.packages);
  if (
    owner?.name !== input.file.workspacePackage.name ||
    owner.manifestPath !== input.file.workspacePackage.manifestPath ||
    !safeExistingGeneratedAncestors(
      input.consumerRoot,
      input.consumerRootIdentity,
      owner.rootPath,
      targetPath
    )
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
      ? externalDeclarationKind(
          input.file.workspacePackage.dependencies,
          packageName,
          input.inventory
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
      exported: subpathExported(
        target,
        subpath,
        input.reference,
        input.file.workspacePackage,
        input.file.path
      ),
      subpath
    };
  }
  return {
    kind: "workspace-package",
    workspacePackage: target,
    declaration,
    exported: subpathExported(
      target,
      subpath,
      input.reference,
      input.file.workspacePackage,
      input.file.path
    ),
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
