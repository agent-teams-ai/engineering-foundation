import { readFileSync } from "node:fs";
import { compareVersionCore, parsePublishedVersion, parseStableVersion } from "./release-publish-registry-version.mjs";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PORTABLE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/-]+$/u;
const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
]);

// This is qualification membership, not a dependency graph or release order.
export const PUBLISHABLE_PACKAGE_CATALOG = Object.freeze([
  Object.freeze({
    changelogPath: "packages/ci-input-proof/CHANGELOG.md",
    manifestPath: "packages/ci-input-proof/package.json",
    name: "@agent-teams/ci-input-proof",
    root: "packages/ci-input-proof",
  }),
  Object.freeze({
    changelogPath: "packages/feature-module-standard/CHANGELOG.md",
    manifestPath: "packages/feature-module-standard/package.json",
    name: "@agent-teams/feature-module-standard",
    root: "packages/feature-module-standard",
  }),
  Object.freeze({
    changelogPath: "packages/repository-mutation/CHANGELOG.md",
    manifestPath: "packages/repository-mutation/package.json",
    name: "@agent-teams/repository-mutation",
    root: "packages/repository-mutation",
  }),
  Object.freeze({
    changelogPath: "packages/document-authoring/CHANGELOG.md",
    manifestPath: "packages/document-authoring/package.json",
    name: "@agent-teams/document-authoring",
    root: "packages/document-authoring",
  }),
  Object.freeze({
    changelogPath: "packages/engineering-foundation/CHANGELOG.md",
    manifestPath: "packages/engineering-foundation/package.json",
    name: "@agent-teams/engineering-foundation",
    required: true,
    root: "packages/engineering-foundation",
  }),
  Object.freeze({
    changelogPath: "packages/docs-protocol/CHANGELOG.md",
    manifestPath: "packages/docs-protocol/package.json",
    name: "@agent-teams/docs-protocol",
    root: "packages/docs-protocol",
  }),
  Object.freeze({
    changelogPath: "packages/docs-protocol-mcp/CHANGELOG.md",
    manifestPath: "packages/docs-protocol-mcp/package.json",
    name: "@agent-teams/docs-protocol-mcp",
    root: "packages/docs-protocol-mcp",
  }),
  Object.freeze({
    changelogPath: "packages/docs-protocol-agent-teams/CHANGELOG.md",
    manifestPath: "packages/docs-protocol-agent-teams/package.json",
    name: "@agent-teams/docs-protocol-agent-teams",
    root: "packages/docs-protocol-agent-teams",
  }),
  Object.freeze({
    changelogPath: "packages/stack-toolchain/CHANGELOG.md",
    manifestPath: "packages/stack-toolchain/package.json",
    name: "stack-toolchain",
    root: "packages/stack-toolchain",
  }),
]);

function fail(message) {
  throw new Error(`Publishable package projection is invalid: ${message}`);
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    fail("qualification catalog must be a non-empty array");
  }
  for (const [index, entry] of catalog.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`catalog[${index}] must be an object`);
    }
    const expectedKeys = ["changelogPath", "manifestPath", "name", "root"];
    if (entry.required !== undefined) {
      expectedKeys.push("required");
    }
    if (Object.keys(entry).toSorted().join("\0") !== expectedKeys.toSorted().join("\0")) {
      fail(`catalog[${index}] may contain package metadata only`);
    }
    if (typeof entry.name !== "string" || !PACKAGE_NAME.test(entry.name)) {
      fail(`catalog[${index}].name must be a canonical npm package name`);
    }
    for (const key of ["root", "manifestPath", "changelogPath"]) {
      if (typeof entry[key] !== "string" || !PORTABLE_PATH.test(entry[key])) {
        fail(`catalog[${index}].${key} must be a portable repository-relative path`);
      }
    }
    if (
      entry.manifestPath !== `${entry.root}/package.json` ||
      entry.changelogPath !== `${entry.root}/CHANGELOG.md`
    ) {
      fail(`catalog[${index}] metadata must remain inside its package root`);
    }
    if (entry.required !== undefined && entry.required !== true) {
      fail(`catalog[${index}].required may only be true when present`);
    }
  }
  for (const key of ["name", "root", "manifestPath", "changelogPath"]) {
    if (new Set(catalog.map((entry) => entry[key])).size !== catalog.length) {
      fail(`catalog ${key} values must be unique`);
    }
  }
}

function manifestFor(manifestsByName, entry) {
  const manifest = manifestsByName.get(entry.name);
  if (manifest === undefined) {
    fail(`manifest is missing for ${entry.name}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${entry.manifestPath} must contain a JSON object`);
  }
  if (manifest.name !== entry.name) {
    fail(`${entry.manifestPath} identity must be ${entry.name}`);
  }
  return manifest;
}

// Explicit stable caret branches retain the supported windows when the workspace advances.
export function workspacePeerRange(reference, workspaceVersion) {
  const version = typeof workspaceVersion === "string" ? parsePublishedVersion(workspaceVersion) : undefined;
  if (version === undefined) {
    fail("optional workspace peer requires an actual workspace version");
  }
  if (reference === "workspace:^") {
    return `^${workspaceVersion}`;
  }
  const branches = reference.startsWith("workspace:^")
    ? reference.slice("workspace:".length).split(" || ") : [];
  const minimums = branches.map(branch => branch.startsWith("^")
    ? parseStableVersion(branch.slice(1)) : undefined);
  if (minimums.length === 0 || minimums.some(minimum => minimum === undefined) || version.iteration !== undefined) {
    fail(`optional workspace peer ${reference} does not admit workspace version ${workspaceVersion}`);
  }
  const admitted = minimums.some(minimum => {
    const [major, minor, patch] = minimum;
    const upper = major > 0n ? [major + 1n, 0n, 0n]
      : minor > 0n ? [0n, minor + 1n, 0n] : [0n, 0n, patch + 1n];
    return compareVersionCore(version.core, minimum) >= 0 && compareVersionCore(version.core, upper) < 0;
  });
  if (!admitted) {
    fail(`optional workspace peer ${reference} does not admit workspace version ${workspaceVersion}`);
  }
  return reference.slice("workspace:".length);
}

// An internal package is declared once, as workspace:*. The one allowed pair is an optional runtime peer caret
// (peerDependencies workspace:^ or explicit stable caret branches) together with the workspace link that builds and tests it
// (devDependencies workspace:*); the pair is one ordering edge, recorded under peerDependencies.
function internalDeclaration(ownerName, name, uses, optionalPeer, workspaceVersion) {
  const peer = uses.find(({ section }) => section === "peerDependencies");
  const pair = uses.length === 2 &&
    optionalPeer === true &&
    peer?.reference.startsWith("workspace:^") &&
    uses.some(({ reference, section }) => section === "devDependencies" && reference === "workspace:*");
  if (pair) {
    workspacePeerRange(peer.reference, workspaceVersion);
    return Object.freeze({ name, section: "peerDependencies" });
  }
  if (uses.length > 1) {
    fail(`${ownerName} declares an internal package in multiple dependency sections`);
  }
  if (uses[0].reference !== "workspace:*") {
    fail(`${ownerName} must reference internal package ${name} as workspace:*`);
  }
  return Object.freeze({ name, section: uses[0].section });
}

function dependencyDeclarations(manifest, ownerName, qualifiedNames, manifestsByName) {
  const found = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (dependencies === undefined) {
      continue;
    }
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      fail(`${ownerName} ${section} must be an object`);
    }
    for (const [name, reference] of Object.entries(dependencies)) {
      if (!PACKAGE_NAME.test(name) || typeof reference !== "string" || reference === "") {
        fail(`${ownerName} has a malformed ${section} manifest reference`);
      }
      if (reference.startsWith("workspace:") && !qualifiedNames.has(name)) {
        fail(`${ownerName} declares unknown internal workspace package ${name}`);
      }
      if (!qualifiedNames.has(name)) {
        continue;
      }
      if (name === ownerName) {
        fail(`${ownerName} declares a self dependency`);
      }
      found.set(name, [...(found.get(name) ?? []), { reference, section }]);
    }
  }
  const declarations = [...found].map(([name, uses]) =>
    internalDeclaration(ownerName, name, uses, manifest.peerDependenciesMeta?.[name]?.optional,
      manifestsByName.get(name)?.version));
  return Object.freeze(declarations.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function topologicalOrder(catalogByName, dependencies) {
  const dependents = new Map([...catalogByName.keys()].map((name) => [name, []]));
  const remaining = new Map();
  for (const [name, edges] of Object.entries(dependencies)) {
    remaining.set(name, edges.length);
    for (const dependency of edges) {
      const targets = dependents.get(dependency);
      if (targets === undefined) {
        fail(`${name} depends on unknown internal package ${dependency}`);
      }
      targets.push(name);
    }
  }
  const ready = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .toSorted();
  const ordered = [];
  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(catalogByName.get(name));
    for (const dependent of dependents.get(name).toSorted()) {
      const count = remaining.get(dependent) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== catalogByName.size) {
    const cyclic = [...remaining].filter(([, count]) => count > 0).map(([name]) => name).toSorted();
    fail(`internal dependency cycle includes ${cyclic.join(", ")}`);
  }
  return Object.freeze(ordered);
}

export function derivePublishablePackageProjection({ catalog, manifestsByName }) {
  validateCatalog(catalog);
  if (!(manifestsByName instanceof Map)) {
    fail("manifestsByName must be a Map");
  }
  const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
  const qualifiedNames = new Set(catalogByName.keys());
  const identities = new Set();
  const declarations = {};
  const dependencies = {};
  const orderingDependencies = {};
  for (const entry of catalog) {
    const manifest = manifestFor(manifestsByName, entry);
    if (identities.has(manifest.name)) {
      fail(`duplicate manifest identity ${manifest.name}`);
    }
    identities.add(manifest.name);
    declarations[entry.name] = dependencyDeclarations(manifest, entry.name, qualifiedNames, manifestsByName);
    dependencies[entry.name] = Object.freeze(declarations[entry.name]
      .filter(({ section }) => section === "dependencies")
      .map(({ name }) => name));
    orderingDependencies[entry.name] = Object.freeze(declarations[entry.name]
      .map(({ name }) => name));
  }
  const frozenDependencies = Object.freeze(dependencies);
  return Object.freeze({
    declarations: Object.freeze(declarations),
    dependencies: frozenDependencies,
    packages: topologicalOrder(catalogByName, orderingDependencies),
  });
}

function loadManifests(catalog) {
  return new Map(catalog.map((entry) => {
    try {
      return [entry.name, JSON.parse(readFileSync(new URL(`../${entry.manifestPath}`, import.meta.url), "utf8"))];
    } catch (error) {
      return fail(`cannot load ${entry.manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

const projection = derivePublishablePackageProjection({
  catalog: PUBLISHABLE_PACKAGE_CATALOG,
  manifestsByName: loadManifests(PUBLISHABLE_PACKAGE_CATALOG),
});

export const PUBLISHABLE_PACKAGES = projection.packages;
export const PUBLISHABLE_PACKAGE_DEPENDENCIES = projection.dependencies;
export const PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS = projection.declarations;

export function publishablePackageByName(name) {
  return PUBLISHABLE_PACKAGES.find((candidate) => candidate.name === name);
}
