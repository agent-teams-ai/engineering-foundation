import { readFileSync } from "node:fs";

const DEFAULT_GRAPH_URL = new URL(
  "../architecture/foundation/package-release-graph.json",
  import.meta.url,
);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PORTABLE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/-]+$/u;
const GRAPH_KEYS = ["packages", "schemaVersion"];
const PACKAGE_KEYS = [
  "changelogPath",
  "dependencies",
  "manifestPath",
  "name",
  "required",
  "root",
];

function fail(message) {
  throw new Error(`Package release graph is invalid: ${message}`);
}

function exactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join("\0") !== [...expected].toSorted().join("\0")
  ) {
    fail(`${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function portablePath(value, label) {
  if (
    typeof value !== "string" ||
    !PORTABLE_PATH.test(value) ||
    value.split("/").some((segment) => segment === "")
  ) {
    fail(`${label} must be a portable repository-relative path`);
  }
  return value;
}

function parsePackage(value, index) {
  const label = `packages[${index}]`;
  exactKeys(value, PACKAGE_KEYS, label);
  if (typeof value.name !== "string" || !PACKAGE_NAME.test(value.name)) {
    fail(`${label}.name must be a canonical npm package name`);
  }
  const root = portablePath(value.root, `${label}.root`);
  const manifestPath = portablePath(value.manifestPath, `${label}.manifestPath`);
  const changelogPath = portablePath(value.changelogPath, `${label}.changelogPath`);
  if (manifestPath !== `${root}/package.json` || changelogPath !== `${root}/CHANGELOG.md`) {
    fail(`${label} manifest and changelog must belong to its package root`);
  }
  if (typeof value.required !== "boolean") {
    fail(`${label}.required must be boolean`);
  }
  if (
    !Array.isArray(value.dependencies) ||
    value.dependencies.some((dependency) => typeof dependency !== "string" || !PACKAGE_NAME.test(dependency)) ||
    new Set(value.dependencies).size !== value.dependencies.length
  ) {
    fail(`${label}.dependencies must contain unique canonical npm package names`);
  }
  return Object.freeze({
    changelogPath,
    dependencies: Object.freeze([...value.dependencies]),
    manifestPath,
    name: value.name,
    required: value.required,
    root,
  });
}

export function parsePackageReleaseGraph(value) {
  exactKeys(value, GRAPH_KEYS, "graph");
  if (value.schemaVersion !== 1) {
    fail("schemaVersion must be 1");
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    fail("packages must be a non-empty array");
  }
  const packages = value.packages.map(parsePackage);
  for (const key of ["name", "root", "manifestPath", "changelogPath"]) {
    if (new Set(packages.map((entry) => entry[key])).size !== packages.length) {
      fail(`package ${key} values must be unique`);
    }
  }
  const packageIndex = new Map(packages.map((entry, index) => [entry.name, index]));
  for (const [index, entry] of packages.entries()) {
    for (const dependency of entry.dependencies) {
      const dependencyIndex = packageIndex.get(dependency);
      if (dependencyIndex === undefined) {
        fail(`${entry.name} depends on undeclared package ${dependency}`);
      }
      if (dependencyIndex >= index) {
        fail(`${entry.name} dependencies must precede it in topological order`);
      }
    }
  }
  return Object.freeze({
    packages: Object.freeze(packages),
    schemaVersion: value.schemaVersion,
  });
}

export const PACKAGE_RELEASE_GRAPH = parsePackageReleaseGraph(
  JSON.parse(readFileSync(DEFAULT_GRAPH_URL, "utf8")),
);

export const PUBLISHABLE_PACKAGES = Object.freeze(PACKAGE_RELEASE_GRAPH.packages.map((entry) =>
  Object.freeze({
    changelogPath: entry.changelogPath,
    manifestPath: entry.manifestPath,
    name: entry.name,
    ...(entry.required ? { required: true } : {}),
    root: entry.root,
  })));

export const PUBLISHABLE_PACKAGE_DEPENDENCIES = Object.freeze(Object.fromEntries(
  PACKAGE_RELEASE_GRAPH.packages.map((entry) => [entry.name, entry.dependencies]),
));

export function publishablePackageByName(name) {
  return PUBLISHABLE_PACKAGES.find((candidate) => candidate.name === name);
}
