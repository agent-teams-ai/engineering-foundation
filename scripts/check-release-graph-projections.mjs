import { readFile } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PACKAGE_RELEASE_GRAPH } from "./publishable-packages.mjs";

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const dependencySections = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

function portableRelativePath(from, to) {
  const path = relative(from, to).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function referencePaths(tsconfig) {
  if (!Array.isArray(tsconfig?.references)) {
    return [];
  }
  return tsconfig.references.map((reference) => reference?.path);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function releaseGraphProjectionDiagnostics({
  graph,
  manifestsByName,
  packageTsconfigsByName,
  rootTsconfig,
}) {
  const diagnostics = [];
  const releaseNames = new Set(graph.packages.map(({ name }) => name));
  const expectedRootReferences = graph.packages.map(({ root }) => `./${root}`);
  const actualRootReferences = referencePaths(rootTsconfig);
  if (!sameValues(actualRootReferences, expectedRootReferences)) {
    diagnostics.push("root tsconfig references must exactly follow package release graph order");
  }

  for (const releasePackage of graph.packages) {
    const manifest = manifestsByName.get(releasePackage.name);
    const tsconfig = packageTsconfigsByName.get(releasePackage.name);
    if (manifest?.name !== releasePackage.name) {
      diagnostics.push(`${releasePackage.name} graph identity does not match its manifest`);
      continue;
    }
    const declaredInternalEdges = [];
    for (const section of dependencySections) {
      for (const dependencyName of Object.keys(manifest[section] ?? {})) {
        if (releaseNames.has(dependencyName)) {
          declaredInternalEdges.push({ dependencyName, section });
        }
      }
    }
    if (new Set(declaredInternalEdges.map(({ dependencyName }) => dependencyName)).size !==
        declaredInternalEdges.length) {
      diagnostics.push(`${releasePackage.name} declares an internal package in multiple dependency sections`);
    }
    const actualEdges = [...new Set(declaredInternalEdges.map(({ dependencyName }) => dependencyName))]
      .toSorted();
    const expectedEdges = [...releasePackage.dependencies].toSorted();
    if (!sameValues(actualEdges, expectedEdges)) {
      diagnostics.push(`${releasePackage.name} internal manifest edges differ from the release graph`);
    }
    for (const dependencyName of releasePackage.dependencies) {
      if (manifest.dependencies?.[dependencyName] !== "workspace:*") {
        diagnostics.push(`${releasePackage.name} must bind ${dependencyName} as a workspace runtime dependency`);
      }
    }
    const expectedReferences = releasePackage.dependencies.map((dependencyName) => {
      const dependency = graph.packages.find(({ name }) => name === dependencyName);
      return portableRelativePath(releasePackage.root, dependency.root);
    });
    if (!sameValues(referencePaths(tsconfig), expectedReferences)) {
      diagnostics.push(`${releasePackage.name} tsconfig references differ from the release graph`);
    }
  }
  return Object.freeze(diagnostics.toSorted());
}

async function readJson(path) {
  return JSON.parse(await readFile(resolvePath(repositoryRoot, path), "utf8"));
}

export async function validateReleaseGraphProjections(graph = PACKAGE_RELEASE_GRAPH) {
  const manifestsByName = new Map();
  const packageTsconfigsByName = new Map();
  await Promise.all(graph.packages.flatMap((releasePackage) => [
    readJson(releasePackage.manifestPath).then((manifest) =>
      manifestsByName.set(releasePackage.name, manifest)),
    readJson(`${releasePackage.root}/tsconfig.json`).then((tsconfig) =>
      packageTsconfigsByName.set(releasePackage.name, tsconfig)),
  ]));
  const diagnostics = releaseGraphProjectionDiagnostics({
    graph,
    manifestsByName,
    packageTsconfigsByName,
    rootTsconfig: await readJson("tsconfig.json"),
  });
  if (diagnostics.length > 0) {
    throw new Error(`Release graph projection check failed:\n- ${diagnostics.join("\n- ")}`);
  }
  return Object.freeze({ packageCount: graph.packages.length });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolvePath(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  const result = await validateReleaseGraphProjections();
  process.stdout.write(`Validated ${result.packageCount} release graph package projections.\n`);
}
