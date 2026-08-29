import { readFileSync } from "node:fs";

const DEFAULT_CATALOG_URL = new URL(
  "../architecture/foundation/npm-package-bootstrap.json",
  import.meta.url,
);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]*$/u;
export const PORTABLE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/-]+$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const GIT_OBJECT = /^[a-f0-9]{40}$/u;
const BOOTSTRAP_STATES = new Set(["approved", "candidate", "historical"]);
const CATALOG_KEYS = ["packages", "registry", "repository", "schemaVersion"];
const PACKAGE_KEYS = [
  "approval",
  "bootstrapVersion",
  "contentPolicy",
  "dependencies",
  "deprecationMessage",
  "id",
  "manifestPath",
  "name",
  "provenance",
  "root",
  "state",
  "tags",
];
const CONTENT_POLICY_KEYS = ["exact", "prefixes", "required"];
const DEPENDENCY_KEYS = ["name", "version"];
const PROVENANCE_KEYS = ["ref", "workflowPath"];
const APPROVAL_KEYS = ["archiveIntegrity", "packageTree"];

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fail(message) {
  throw new Error(`npm package bootstrap refused: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value) || Object.keys(value).toSorted().join("\0") !== [...expected].toSorted().join("\0")) {
    fail(`${label} keys must be exactly ${expected.join(", ")}.`);
  }
}

export function exactStringArray(value, label, { nonempty = true } = {}) {
  if (
    !Array.isArray(value) ||
    (nonempty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length
  ) {
    fail(`${label} must be a${nonempty ? " non-empty" : ""} unique string array.`);
  }
}

export function canonicalIntegrity(value, label = "archive integrity") {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value ?? "");
  if (match === null) {
    fail(`${label} must be canonical SHA-512 SRI.`);
  }
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== match[1]) {
    fail(`${label} must be canonical SHA-512 SRI.`);
  }
  return value;
}

function portablePath(value, label) {
  if (typeof value !== "string" || !PORTABLE_PATH.test(value)) {
    fail(`${label} must be a portable repository-relative path.`);
  }
  return value;
}

function parseDependency(value, label) {
  exactKeys(value, DEPENDENCY_KEYS, label);
  if (!PACKAGE_NAME.test(value.name) || !SEMVER.test(value.version)) {
    fail(`${label} must contain an exact npm package name and version.`);
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function parseContentPolicy(value, label) {
  exactKeys(value, CONTENT_POLICY_KEYS, label);
  for (const key of CONTENT_POLICY_KEYS) {
    exactStringArray(value[key], `${label}.${key}`);
    for (const path of value[key]) {
      portablePath(path, `${label}.${key}`);
      if ((key === "prefixes") !== path.endsWith("/")) {
        fail(`${label}.${key} contains an invalid exact path or prefix.`);
      }
    }
  }
  if (value.required.some((path) => !value.exact.includes(path))) {
    fail(`${label}.required must be a subset of exact paths.`);
  }
  return Object.freeze({
    exact: Object.freeze([...value.exact]),
    prefixes: Object.freeze([...value.prefixes]),
    required: Object.freeze([...value.required]),
  });
}

function parseApproval(value, state, label) {
  if (state === "candidate") {
    if (value !== null) {
      fail(`${label} must be null while the package is a candidate.`);
    }
    return null;
  }
  exactKeys(value, APPROVAL_KEYS, label);
  if (!GIT_OBJECT.test(value.packageTree)) {
    fail(`${label}.packageTree must be an exact Git tree object ID.`);
  }
  return Object.freeze({
    archiveIntegrity: canonicalIntegrity(value.archiveIntegrity, `${label}.archiveIntegrity`),
    packageTree: value.packageTree,
  });
}

function parsePackage(value, index) {
  const label = `packages[${index}]`;
  exactKeys(value, PACKAGE_KEYS, label);
  if (!PACKAGE_ID.test(value.id) || !PACKAGE_NAME.test(value.name)) {
    fail(`${label} has an invalid package ID or npm package name.`);
  }
  if (!BOOTSTRAP_STATES.has(value.state) || value.bootstrapVersion !== "0.0.0") {
    fail(`${label} has an unsupported state or bootstrap version.`);
  }
  portablePath(value.root, `${label}.root`);
  portablePath(value.manifestPath, `${label}.manifestPath`);
  if (value.manifestPath !== `${value.root}/package.json`) {
    fail(`${label}.manifestPath must be the package root manifest.`);
  }
  if (typeof value.deprecationMessage !== "string" || value.deprecationMessage.length < 20 || value.deprecationMessage.includes("\n")) {
    fail(`${label}.deprecationMessage must be one bounded human-readable line.`);
  }
  exactStringArray(value.tags, `${label}.tags`);
  if (value.tags.toSorted().join("\0") !== "bootstrap\0latest") {
    fail(`${label}.tags must be exactly bootstrap and latest.`);
  }
  exactKeys(value.provenance, PROVENANCE_KEYS, `${label}.provenance`);
  portablePath(value.provenance.workflowPath, `${label}.provenance.workflowPath`);
  if (value.provenance.ref !== "refs/heads/main") {
    fail(`${label}.provenance.ref must be refs/heads/main.`);
  }
  if (!Array.isArray(value.dependencies) || new Set(value.dependencies.map((entry) => entry?.name)).size !== value.dependencies.length) {
    fail(`${label}.dependencies must contain unique package names.`);
  }
  return Object.freeze({
    approval: parseApproval(value.approval, value.state, `${label}.approval`),
    bootstrapVersion: value.bootstrapVersion,
    contentPolicy: parseContentPolicy(value.contentPolicy, `${label}.contentPolicy`),
    dependencies: Object.freeze(value.dependencies.map((entry, dependencyIndex) =>
      parseDependency(entry, `${label}.dependencies[${dependencyIndex}]`))),
    deprecationMessage: value.deprecationMessage,
    id: value.id,
    manifestPath: value.manifestPath,
    name: value.name,
    provenance: Object.freeze({ ...value.provenance }),
    root: value.root,
    state: value.state,
    tags: Object.freeze([...value.tags]),
  });
}

export function parseBootstrapCatalog(value) {
  exactKeys(value, CATALOG_KEYS, "catalog");
  if (value.schemaVersion !== 1 || value.registry !== "https://registry.npmjs.org/") {
    fail("catalog must use schema version 1 and the canonical public npm registry.");
  }
  if (value.repository !== "https://github.com/agent-teams-ai/engineering-foundation") {
    fail("catalog repository must be the canonical Engineering Foundation repository.");
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    fail("catalog packages must be non-empty.");
  }
  const packages = value.packages.map(parsePackage);
  for (const key of ["id", "name", "root", "manifestPath"]) {
    if (new Set(packages.map((entry) => entry[key])).size !== packages.length) {
      fail(`catalog package ${key} values must be unique.`);
    }
  }
  return Object.freeze({
    packages: Object.freeze(packages),
    registry: value.registry,
    repository: value.repository,
    schemaVersion: value.schemaVersion,
  });
}

export const NPM_PACKAGE_BOOTSTRAP = parseBootstrapCatalog(
  JSON.parse(readFileSync(DEFAULT_CATALOG_URL, "utf8")),
);

export function bootstrapPackageById(id, { approved = false, catalog = NPM_PACKAGE_BOOTSTRAP } = {}) {
  const profile = catalog.packages.find((entry) => entry.id === id);
  if (profile === undefined) {
    fail("package ID is not in the closed bootstrap catalog.");
  }
  if (approved && profile.state !== "approved") {
    fail(`${profile.name} bootstrap is not approved.`);
  }
  return profile;
}
