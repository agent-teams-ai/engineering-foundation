import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { createSourceDependenciesCapability } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const foundationName = "@agent-teams/engineering-foundation";
const docsProtocolName = "@agent-teams/docs-protocol";
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function json(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function importedSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
}

function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) {return;}
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function pathsContaining(value, packageNames, path = []) {
  if (typeof value === "string") {
    const evidence = [...path, value].join(" ");
    return packageNames.every((name) => evidence.includes(name)) ? [path.join(".")] : [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return [];}
  return Object.entries(value).flatMap(([key, entry]) => {
    const next = [...path, key];
    const evidence = next.join(" ");
    const here = packageNames.every((name) => evidence.includes(name)) ? [next.join(".")] : [];
    return [...here, ...pathsContaining(entry, packageNames, next)];
  });
}

function reverseDependencyReferences(foundation, workspace = {}) {
  const direct = dependencySections.flatMap((section) =>
    Object.hasOwn(object(foundation[section]), docsProtocolName) ? [`${section}.${docsProtocolName}`] : []);
  const foundationPnpm = ["overrides", "dependenciesMeta", "packageExtensions"].flatMap((section) =>
    pathsContaining(object(foundation.pnpm)[section], [docsProtocolName], ["pnpm", section]));
  const workspacePnpm = ["overrides", "packageExtensions"].flatMap((section) =>
    pathsContaining(object(workspace.pnpm)[section], [foundationName, docsProtocolName], ["pnpm", section]));
  return [...direct, ...foundationPnpm, ...workspacePnpm].toSorted();
}

test("publishable package catalog and manifests preserve one-way layering", async () => {
  assert.deepEqual(
    PUBLISHABLE_PACKAGES.map((releasePackage) => releasePackage.name),
    [foundationName],
  );
  const foundation = await json("packages/engineering-foundation/package.json");
  const docsProtocol = await json("packages/docs-protocol/package.json");
  const workspace = await json("package.json");
  assert.equal(docsProtocol.private, true);
  assert.equal(docsProtocol.publishConfig, undefined);
  assert.equal(docsProtocol.version, "0.0.0");
  assert.deepEqual(reverseDependencyReferences(foundation, workspace), []);
  assert.equal(docsProtocol.dependencies?.[foundationName], "workspace:*");
  assert.match(foundation.version, exactVersion);
  assert.equal(
    docsProtocol.dependencies[foundationName] === "workspace:*" ? foundation.version : docsProtocol.dependencies[foundationName],
    foundation.version,
    "Docs Protocol must pack its one-way Foundation dependency to the exact Foundation version",
  );
  const packageDirectories = await readdir(join(repositoryRoot, "packages"), {
    withFileTypes: true,
  });
  for (const entry of packageDirectories.filter((candidate) => candidate.isDirectory())) {
    const manifest = await json(`packages/${entry.name}/package.json`);
    if (manifest.name !== docsProtocolName) {
      assert.equal(
        manifest.dependencies?.[foundationName],
        undefined,
        `${manifest.name} cannot use Foundation as a runtime dependency`,
      );
    }
  }
});

test("reverse dependency guard rejects alternate manifest and pnpm injection paths", () => {
  const directCases = dependencySections.map((section) => ({ [section]: { [docsProtocolName]: "1.0.0" } }));
  const pnpmCases = [
    { pnpm: { overrides: { [docsProtocolName]: "1.0.0" } } },
    { pnpm: { dependenciesMeta: { [docsProtocolName]: { injected: true } } } },
    { pnpm: { packageExtensions: { [`${foundationName}@*`]: { dependencies: { [docsProtocolName]: "1.0.0" } } } } }
  ];
  for (const manifest of [...directCases, ...pnpmCases]) {
    assert.notDeepEqual(reverseDependencyReferences(manifest), [], JSON.stringify(manifest));
  }
  const workspaceCases = [
    { pnpm: { overrides: { [`${foundationName}>${docsProtocolName}`]: "1.0.0" } } },
    { pnpm: { packageExtensions: { [`${foundationName}@*`]: { optionalDependencies: { [docsProtocolName]: "1.0.0" } } } } }
  ];
  for (const workspace of workspaceCases) {
    assert.notDeepEqual(reverseDependencyReferences({}, workspace), [], JSON.stringify(workspace));
  }
  assert.deepEqual(reverseDependencyReferences({}, { pnpm: { overrides: { [docsProtocolName]: "1.0.0" } } }), []);
});

test("Foundation source and source-boundary authority cannot import Docs Protocol", async () => {
  const foundationSources = await sourceFiles(
    join(repositoryRoot, "packages", "engineering-foundation", "src"),
  );
  for (const path of foundationSources) {
    assert.doesNotMatch(await readFile(path, "utf8"), /@agent-teams\/docs-protocol/u, path);
  }
  const policy = parseYaml(
    await readFile(
      join(repositoryRoot, "architecture", "foundation", "source-dependencies.yaml"),
      "utf8",
    ),
  );
  const foundationBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/engineering-foundation/")),
  );
  assert.ok(foundationBoundaries.length > 0);
  for (const boundary of foundationBoundaries) {
    assert.ok(!boundary.allow.packages.includes(docsProtocolName), boundary.id);
  }
  const docsBoundary = policy.boundaries.find(
    (boundary) => boundary.id === "docs-protocol.package",
  );
  const docsSources = await sourceFiles(join(repositoryRoot, "packages/docs-protocol/src"));
  const specifiers = (await Promise.all(docsSources.map((path) => readFile(path, "utf8"))))
    .flatMap(importedSpecifiers);
  const observedBuiltins = [...new Set(specifiers.filter((specifier) => specifier.startsWith("node:")))].toSorted();
  const observedPackages = [...new Set(specifiers.map(packageName).filter(Boolean))].toSorted();
  assert.deepEqual(docsBoundary.allow.builtins.toSorted(), observedBuiltins);
  assert.deepEqual(docsBoundary.allow.packages.toSorted(), observedPackages);
  const docsManifest = await json("packages/docs-protocol/package.json");
  assert.deepEqual(Object.keys(docsManifest.dependencies).toSorted(), observedPackages);
});

test("source dependency capability accepts the exact repository allowlist", async () => {
  const report = await createSourceDependenciesCapability().run({
    consumerRoot: repositoryRoot,
    configPath: "architecture/foundation/source-dependencies.yaml",
  });
  assert.equal(report.outcome, "passed", JSON.stringify(report, null, 2));
});

test("current authoring guidance uses only the unified explicit-mutation CLI", async () => {
  for (const path of ["README.md", "docs/architecture/document-authoring-protocol.md"]) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    assert.doesNotMatch(source, /agent-teams-foundation docs/u, path);
    assert.doesNotMatch(source, /without `--dry-run`/u, path);
  }
});

test("document authoring public surface exposes no directory rollback capability", async () => {
  const runtime = await import(
    "../packages/engineering-foundation/dist/document-authoring/index.js"
  );
  assert.deepEqual(
    Object.keys(runtime).filter((name) => /rollback/iu.test(name)),
    [],
  );
  const declarations = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/dist/document-authoring/index.d.ts",
  ), "utf8");
  assert.doesNotMatch(
    declarations,
    /DocumentParentRollbackResultV2|directory-removed/iu,
  );
  const authoringSources = await sourceFiles(join(
    repositoryRoot,
    "packages/engineering-foundation/src/document-authoring",
  ));
  for (const path of authoringSources) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /DocumentParentRollbackResultV2|directory-removed/iu,
      path,
    );
  }
});

test("production and generic directory adapters share the internal bind kernel", async () => {
  const production = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/src/document-authoring/adapters/node/node-document-parent-materializer.ts",
  ), "utf8");
  const generic = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/src/repository-mutation/adapters/node/node-directory-materialization.ts",
  ), "utf8");
  for (const source of [production, generic]) {
    assert.match(source, /node-create-and-bind-directory\.js/iu);
    assert.match(source, /createAndBindNodeDirectory\s*\(/u);
  }
  const publicMutationBarrel = await readFile(join(
    repositoryRoot,
    "packages/engineering-foundation/src/mutation/index.ts",
  ), "utf8");
  assert.doesNotMatch(publicMutationBarrel, /createAndBindNodeDirectory/u);
});
