import { readFile } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
  PUBLISHABLE_PACKAGE_DEPENDENCIES,
  PUBLISHABLE_PACKAGES,
} from "./publishable-packages.mjs";

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function portableRelativePath(from, to) {
  const path = relative(from, to).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function referencePaths(tsconfig, label, diagnostics, { required = false } = {}) {
  if (tsconfig?.references === undefined && !required) {
    return [];
  }
  if (!Array.isArray(tsconfig?.references)) {
    diagnostics.push(`${label} references must be an array`);
    return [];
  }
  const paths = tsconfig.references.map((reference) => reference?.path);
  if (paths.some((path) => typeof path !== "string" || path === "")) {
    diagnostics.push(`${label} contains a malformed reference`);
    return [];
  }
  if (new Set(paths).size !== paths.length) {
    diagnostics.push(`${label} contains a duplicate reference`);
  }
  return paths;
}

function sameSet(left, right) {
  return left.length === right.length &&
    left.toSorted().every((value, index) => value === right.toSorted()[index]);
}

export function releaseGraphProjectionDiagnostics({
  dependencies,
  dependencyDeclarations,
  packageTsconfigsByName,
  packages,
  rootTsconfig,
}) {
  const diagnostics = [];
  const packageByName = new Map(packages.map((entry) => [entry.name, entry]));
  if (packageByName.size !== packages.length) {
    diagnostics.push("projected package identities must be unique");
  }
  const expectedRootReferences = packages.map(({ root }) => `./${root}`);
  const actualRootReferences = referencePaths(
    rootTsconfig,
    "root tsconfig",
    diagnostics,
    { required: true },
  );
  if (!sameSet(actualRootReferences, expectedRootReferences)) {
    diagnostics.push("root tsconfig references must exactly include every qualified package");
  }

  for (const releasePackage of packages) {
    const tsconfig = packageTsconfigsByName.get(releasePackage.name);
    if (tsconfig === undefined) {
      diagnostics.push(`${releasePackage.name} tsconfig is missing`);
      continue;
    }
    const dependencyNames = dependencyDeclarations === undefined
      ? dependencies[releasePackage.name]
      : dependencyDeclarations[releasePackage.name]?.map(({ name }) => name);
    if (!Array.isArray(dependencyNames)) {
      diagnostics.push(`${releasePackage.name} manifest-derived dependencies are missing`);
      continue;
    }
    const expectedReferences = dependencyNames.map((dependencyName) => {
      const dependency = packageByName.get(dependencyName);
      if (dependency === undefined) {
        diagnostics.push(`${releasePackage.name} has unknown projected dependency ${dependencyName}`);
        return undefined;
      }
      return portableRelativePath(releasePackage.root, dependency.root);
    }).filter((path) => path !== undefined);
    const actualReferences = referencePaths(
      tsconfig,
      `${releasePackage.name} tsconfig`,
      diagnostics,
    );
    if (!sameSet(actualReferences, expectedReferences)) {
      diagnostics.push(
        `${releasePackage.name} tsconfig references must match manifest-derived dependencies`,
      );
    }
  }
  return Object.freeze(diagnostics.toSorted());
}

async function readJson(path) {
  return JSON.parse(await readFile(resolvePath(repositoryRoot, path), "utf8"));
}

export async function validateReleaseGraphProjections({
  dependencyDeclarations = PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
  dependencies = PUBLISHABLE_PACKAGE_DEPENDENCIES,
  packages = PUBLISHABLE_PACKAGES,
} = {}) {
  const packageTsconfigsByName = new Map();
  await Promise.all(packages.map((releasePackage) =>
    readJson(`${releasePackage.root}/tsconfig.json`).then((tsconfig) =>
      packageTsconfigsByName.set(releasePackage.name, tsconfig))));
  const diagnostics = releaseGraphProjectionDiagnostics({
    dependencies,
    dependencyDeclarations,
    packageTsconfigsByName,
    packages,
    rootTsconfig: await readJson("tsconfig.json"),
  });
  if (diagnostics.length > 0) {
    throw new Error(`Release graph projection check failed:\n- ${diagnostics.join("\n- ")}`);
  }
  return Object.freeze({ packageCount: packages.length });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = await validateReleaseGraphProjections();
  process.stdout.write(`Validated ${result.packageCount} package graph projections.\n`);
}
