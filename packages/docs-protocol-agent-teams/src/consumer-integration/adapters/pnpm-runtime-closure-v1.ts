import { createHash } from "node:crypto";

import {
  canonicalConsumerIntegrationJson,
  type QualifiedDocsCohortBindingV1
} from "../application-api.js";

const PACKAGE_MANAGER = "pnpm@11.18.0";
const LOCKFILE_VERSION = "9.0";
const MAXIMUM_PACKAGES = 2048;
const MAXIMUM_DEPTH = 64;
const MAXIMUM_BYTES = 2 * 1024 * 1024;
const TYPE_ONLY_PEER = "@types/node";
const REGISTRY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;

type JsonRecord = Record<string, unknown>;

interface ClosureEdge {
  readonly name: string;
  readonly locator: string;
}

interface SourceClosureEdge extends ClosureEdge {
  readonly sourceLocator: string;
}

type ClosureRoot = SourceClosureEdge;

export interface PnpmRuntimeClosureTarget {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly direct?: boolean;
}

interface ProjectedClosurePackage {
  readonly locator: string;
  readonly integrity: string;
  readonly dependencies: readonly ClosureEdge[];
  readonly optionalDependencies: readonly ClosureEdge[];
}

interface ProjectedRuntimeClosure {
  readonly packages: readonly ProjectedClosurePackage[];
  readonly snapshots: ReadonlyMap<string, JsonRecord>;
}

export class PnpmRuntimeClosureError extends Error {
  public readonly code = "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH";
}

function fail(message: string): never {
  throw new PnpmRuntimeClosureError(message);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be one object.`);
  }
  return value as JsonRecord;
}

function binding(container: JsonRecord, name: string): readonly unknown[] {
  return ["dependencies", "devDependencies", "optionalDependencies"].flatMap((section) => {
    const entries = container[section];
    return entries === null || typeof entries !== "object" || Array.isArray(entries) ||
      (entries as JsonRecord)[name] === undefined ? [] : [(entries as JsonRecord)[name]];
  });
}

function locator(name: string, raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length > 1024 || /[\s\\:#]/u.test(raw)) {
    fail(`${label} is not one bounded registry resolution.`);
  }
  const version = raw.split("(", 1)[0]!;
  if (!REGISTRY_VERSION.test(version) || raw.startsWith("npm:")) {
    fail(`${label} uses a non-registry or aliased resolution.`);
  }
  return `${name}@${raw}`;
}

function normalizeTypeOnlyPeerContext(raw: string, label: string): string {
  const normalized = raw.replace(/\(@types\/node@([^()]+)\)/gu, (_match, version: string) => {
    if (!REGISTRY_VERSION.test(version)) {
      fail(`${label} has an invalid ${TYPE_ONLY_PEER} peer context.`);
    }
    return "";
  });
  if (normalized.includes(`(${TYPE_ONLY_PEER}@`)) {
    fail(`${label} has an invalid ${TYPE_ONLY_PEER} peer context.`);
  }
  return normalized;
}

function normalizedLocator(name: string, raw: unknown, label: string): string {
  const source = locator(name, raw, label).slice(`${name}@`.length);
  return `${name}@${normalizeTypeOnlyPeerContext(source, label)}`;
}

function declaresTypeOnlyPeer(packageEntry: JsonRecord, name: string): boolean {
  const peers = packageEntry["peerDependencies"];
  return name === TYPE_ONLY_PEER && peers !== null && typeof peers === "object" &&
    !Array.isArray(peers) && Object.hasOwn(peers, name);
}

function sortedEdges(
  snapshot: JsonRecord,
  packageEntry: JsonRecord,
  section: string,
  label: string
): readonly SourceClosureEdge[] {
  const value = snapshot[section] ?? {};
  const source = record(value, `${label} ${section}`);
  return Object.entries(source)
    .filter(([name]) => !declaresTypeOnlyPeer(packageEntry, name))
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, raw]) => ({
      name,
      locator: normalizedLocator(name, raw, `${label} ${section}.${name}`),
      sourceLocator: locator(name, raw, `${label} ${section}.${name}`)
    }));
}

function normalizedSnapshot(
  snapshot: JsonRecord,
  packageEntry: JsonRecord,
  label: string
): JsonRecord {
  const normalized = { ...snapshot };
  for (const section of ["dependencies", "optionalDependencies"]) {
    const value = snapshot[section];
    if (value === undefined) {
      continue;
    }
    const source = record(value, `${label} ${section}`);
    const entries = Object.entries(source)
      .filter(([name]) => !declaresTypeOnlyPeer(packageEntry, name))
      .map(([name, raw]) => {
        if (typeof raw !== "string") {
          fail(`${label} ${section}.${name} is not one bounded registry resolution.`);
        }
        locator(name, raw, `${label} ${section}.${name}`);
        return [name, normalizeTypeOnlyPeerContext(raw, `${label} ${section}.${name}`)];
      });
    if (entries.length === 0) {
      delete normalized[section];
    } else {
      normalized[section] = Object.fromEntries(entries);
    }
  }
  return normalized;
}

function packageRoots(cohort: QualifiedDocsCohortBindingV1): readonly {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}[] {
  return [
    { name: "@agent-teams/docs-protocol", ...cohort.packages.docsProtocol },
    { name: "@agent-teams/engineering-foundation", ...cohort.packages.engineeringFoundation }
  ];
}

function projectRuntimeClosure(
  packages: JsonRecord,
  snapshots: JsonRecord,
  roots: readonly ClosureRoot[]
): ProjectedRuntimeClosure {
  const pending = roots.map(({ locator: rootLocator, sourceLocator }) => ({
    locator: rootLocator,
    sourceLocator,
    depth: 0
  }));
  const visitedSources = new Set<string>();
  const projectedByLocator = new Map<string, {
    readonly integrity: string;
    readonly snapshot: JsonRecord;
  }>();
  const projectedPackages: ProjectedClosurePackage[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visitedSources.has(current.sourceLocator)) {
      continue;
    }
    if (current.depth > MAXIMUM_DEPTH) {
      fail(`Runtime closure exceeds maximum dependency depth ${MAXIMUM_DEPTH}.`);
    }
    visitedSources.add(current.sourceLocator);
    if (visitedSources.size > MAXIMUM_PACKAGES) {
      fail(`Runtime closure exceeds maximum package count ${MAXIMUM_PACKAGES}.`);
    }
    const physicalLocator = current.sourceLocator.split("(", 1)[0]!;
    const packageEntry = record(packages[physicalLocator], `Runtime closure package ${physicalLocator}`);
    const snapshot = record(
      snapshots[current.sourceLocator],
      `Runtime closure snapshot ${current.sourceLocator}`
    );
    const resolution = record(packageEntry["resolution"], `Runtime closure resolution ${physicalLocator}`);
    const integrity = resolution["integrity"];
    if (typeof integrity !== "string" || !SHA512_SRI.test(integrity)) {
      fail(`Runtime closure locator ${current.sourceLocator} has no exact registry SRI.`);
    }
    const normalized = normalizedSnapshot(snapshot, packageEntry, current.sourceLocator);
    const priorProjection = projectedByLocator.get(current.locator);
    if (priorProjection !== undefined) {
      if (priorProjection.integrity !== integrity ||
        canonicalConsumerIntegrationJson(priorProjection.snapshot) !==
          canonicalConsumerIntegrationJson(normalized)) {
        fail(`Runtime closure has conflicting ${TYPE_ONLY_PEER}-neutral locator ${current.locator}.`);
      }
      continue;
    }
    projectedByLocator.set(current.locator, { integrity, snapshot: normalized });
    const dependencies = sortedEdges(snapshot, packageEntry, "dependencies", current.sourceLocator);
    const optionalDependencies = sortedEdges(
      snapshot,
      packageEntry,
      "optionalDependencies",
      current.sourceLocator
    );
    const edgeByName = new Map<string, string>();
    for (const edge of [...dependencies, ...optionalDependencies]) {
      const prior = edgeByName.get(edge.name);
      if (prior !== undefined && prior !== edge.locator) {
        fail(`Runtime closure locator ${current.locator} has ambiguous dependency ${edge.name}.`);
      }
      edgeByName.set(edge.name, edge.locator);
      pending.push({
        locator: edge.locator,
        sourceLocator: edge.sourceLocator,
        depth: current.depth + 1
      });
    }
    projectedPackages.push({
      locator: current.locator,
      integrity,
      dependencies: dependencies.map(({ name, locator: value }) => ({ name, locator: value })),
      optionalDependencies: optionalDependencies.map(({ name, locator: value }) => ({
        name,
        locator: value
      }))
    });
  }
  projectedPackages.sort(({ locator: left }, { locator: right }) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return { packages: projectedPackages, snapshots: projectedByLocator };
}

export function computePnpmRuntimeClosureDigestForTargets(
  lock: JsonRecord,
  expected: readonly PnpmRuntimeClosureTarget[]
): `sha256:${string}` {
  if (String(lock["lockfileVersion"]) !== LOCKFILE_VERSION) {
    fail("Runtime closure requires pnpm lockfileVersion 9.0.");
  }
  const importers = record(lock["importers"], "Runtime closure importers");
  const packages = record(lock["packages"], "Runtime closure packages");
  const snapshots = record(lock["snapshots"], "Runtime closure snapshots");
  const root = record(importers["."], "Runtime closure root importer");
  const roots = expected.filter(({ direct }) => direct ?? true).map((entry) => {
    const bindings = binding(root, entry.name);
    if (bindings.length !== 1) {
      fail(`${entry.name} runtime closure root binding is not exact.`);
    }
    const selected = record(bindings[0], `${entry.name} runtime closure root binding`);
    if (selected["specifier"] !== entry.version || typeof selected["version"] !== "string") {
      fail(`${entry.name} runtime closure root binding is not exact.`);
    }
    const sourceLocator = locator(entry.name, selected["version"], `${entry.name} runtime closure root`);
    const selectedLocator = normalizedLocator(
      entry.name,
      selected["version"],
      `${entry.name} runtime closure root`
    );
    if (sourceLocator.split("(", 1)[0] !== `${entry.name}@${entry.version}`) {
      fail(`${entry.name} runtime closure root version differs from the Cohort.`);
    }
    const packageEntry = record(packages[`${entry.name}@${entry.version}`], `${entry.name} package`);
    const resolution = record(packageEntry["resolution"], `${entry.name} resolution`);
    if (resolution["integrity"] !== entry.integrity) {
      fail(`${entry.name} runtime closure root integrity differs from the Cohort.`);
    }
    return { name: entry.name, locator: selectedLocator, sourceLocator };
  }).toSorted(({ name: left }, { name: right }) => left < right ? -1 : left > right ? 1 : 0);
  const projectedRoots = roots.map(({ name, locator: value }) => ({ name, locator: value }));

  const closure = projectRuntimeClosure(packages, snapshots, roots);
  for (const entry of expected) {
    const physicalLocator = `${entry.name}@${entry.version}`;
    const matches = closure.packages.filter(({ locator: value }) =>
      value.split("(", 1)[0] === physicalLocator
    );
    if (matches.length !== 1 || matches[0]!.integrity !== entry.integrity) {
      fail(`${entry.name} runtime closure coordinate differs from the Cohort.`);
    }
  }
  const projection = {
    schemaVersion: 1,
    packageManager: PACKAGE_MANAGER,
    lockfileVersion: LOCKFILE_VERSION,
    packageCount: closure.packages.length,
    roots: projectedRoots,
    packages: closure.packages
  };
  if (Buffer.byteLength(canonicalConsumerIntegrationJson(projection), "utf8") > MAXIMUM_BYTES) {
    fail(`Runtime closure projection exceeds ${MAXIMUM_BYTES} bytes.`);
  }
  const physicalLocators = [...new Set(closure.packages.map(({ locator: value }) =>
    value.split("(", 1)[0]!
  ))].toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const pnpmLock = {
    lockfileVersion: LOCKFILE_VERSION,
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { ".": { devDependencies: Object.fromEntries(projectedRoots.map(({ name, locator: value }) => [
      name,
      {
        specifier: expected.find((entry) => entry.name === name)!.version,
        version: value.slice(`${name}@`.length)
      }
    ])) } },
    packages: Object.fromEntries(physicalLocators.map((value) => [value, packages[value]])),
    snapshots: Object.fromEntries(closure.packages.map(({ locator: value }) => [
      value,
      closure.snapshots.get(value)!.snapshot
    ]))
  };
  const source = `${canonicalConsumerIntegrationJson({
    domain: "agent-teams.docs-runtime-closure/v1",
    schemaVersion: 1,
    packageManager: PACKAGE_MANAGER,
    packageCount: closure.packages.length,
    pnpmLock
  })}\n`;
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_BYTES) {
    fail(`Runtime closure evidence exceeds ${MAXIMUM_BYTES} bytes.`);
  }
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function computePnpmRuntimeClosureDigestV1(
  lock: JsonRecord,
  cohort: QualifiedDocsCohortBindingV1
): `sha256:${string}` {
  return computePnpmRuntimeClosureDigestForTargets(lock, packageRoots(cohort));
}
