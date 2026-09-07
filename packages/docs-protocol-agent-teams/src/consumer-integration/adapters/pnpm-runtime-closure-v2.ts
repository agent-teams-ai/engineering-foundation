import { createHash } from "node:crypto";

import type { QualifiedDocsCohortBindingV2 } from "../domain/model.js";
import { canonicalConsumerIntegrationJson } from "../application/policies/consumer-integration-assets.js";
import {
  QUALIFIED_DOCS_COHORT_V2_EDGES,
  qualifiedDocsCohortV2PackageEntries
} from "../application/policies/qualified-docs-cohort-v2.js";
import { PnpmRuntimeClosureError } from "./pnpm-runtime-closure-v1.js";

// Protocol label: independent of the consumer's supported pnpm CLI version.
const PACKAGE_MANAGER = "pnpm@11.20.0";
const LOCKFILE_VERSION = "9.0";
const MAXIMUM_PACKAGES = 2048;
const MAXIMUM_DEPTH = 64;
const MAXIMUM_BYTES = 2 * 1024 * 1024;
const REGISTRY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;

type JsonRecord = Record<string, unknown>;

interface ClosureEdge {
  readonly name: string;
  readonly locator: string;
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

function sortedEdges(snapshot: JsonRecord, section: string, label: string): readonly ClosureEdge[] {
  return Object.entries(record(snapshot[section] ?? {}, `${label} ${section}`))
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, raw]) => ({ name, locator: locator(name, raw, `${label} ${section}.${name}`) }));
}

function compareEdges(left: { from: string; to: string }, right: { from: string; to: string }): number {
  return left.from === right.from ? left.to.localeCompare(right.to) : left.from.localeCompare(right.from);
}

function projectRuntimeClosure(
  packages: JsonRecord,
  snapshots: JsonRecord,
  roots: readonly ClosureEdge[],
  expected: ReturnType<typeof qualifiedDocsCohortV2PackageEntries>
): { readonly locators: readonly string[]; readonly managedEdges: readonly { from: string; to: string }[] } {
  const pending = roots.map(({ locator: value }) => ({ locator: value, depth: 0 }));
  const visited = new Set<string>();
  const managedEdges: { from: string; to: string }[] = [];
  const managedEdgeKeys = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.locator)) {
      continue;
    }
    if (current.depth > MAXIMUM_DEPTH) {
      fail(`Runtime closure exceeds maximum dependency depth ${MAXIMUM_DEPTH}.`);
    }
    visited.add(current.locator);
    if (visited.size > MAXIMUM_PACKAGES) {
      fail(`Runtime closure exceeds maximum package count ${MAXIMUM_PACKAGES}.`);
    }
    const physicalLocator = current.locator.split("(", 1)[0]!;
    const packageEntry = record(packages[physicalLocator], `Runtime closure package ${physicalLocator}`);
    const snapshot = record(snapshots[current.locator], `Runtime closure snapshot ${current.locator}`);
    const resolution = record(packageEntry["resolution"], `Runtime closure resolution ${physicalLocator}`);
    if (typeof resolution["integrity"] !== "string" || !SHA512_SRI.test(resolution["integrity"])) {
      fail(`Runtime closure locator ${current.locator} has no exact registry SRI.`);
    }
    const from = expected.find((entry) => physicalLocator === `${entry.name}@${entry.version}`);
    const edges = [
      ...sortedEdges(snapshot, "dependencies", current.locator),
      ...sortedEdges(snapshot, "optionalDependencies", current.locator)
    ];
    // Both raw references bind; only a conflicting physical resolution is ambiguous.
    const edgeByName = new Map<string, string>();
    for (const edge of edges) {
      const physicalEdge = edge.locator.split("(", 1)[0]!;
      const prior = edgeByName.get(edge.name);
      if (prior !== undefined && prior !== physicalEdge) {
        fail(`Runtime closure locator ${current.locator} has ambiguous dependency ${edge.name}.`);
      }
      edgeByName.set(edge.name, physicalEdge);
      pending.push({ locator: edge.locator, depth: current.depth + 1 });
      if (from !== undefined && expected.some(({ name }) => name === edge.name)) {
        // Coexisting raw peer variants of the same managed source (R1) revisit this
        // source's edges once per variant; the same logical (from, to) managed edge
        // must still be counted exactly once against the closed seven-edge set.
        const edgeKey = `${from.name},${edge.name}`;
        if (!managedEdgeKeys.has(edgeKey)) {
          managedEdgeKeys.add(edgeKey);
          managedEdges.push({ from: from.name, to: edge.name });
        }
      }
    }
  }
  const locators = [...visited].toSorted((left, right) => left.localeCompare(right));
  // Each managed name resolves once physically; its raw peer snapshots all stay bound.
  const physicalResolutions = new Set(locators.map((value) => value.split("(", 1)[0]!));
  for (const entry of expected) {
    const physicalLocator = `${entry.name}@${entry.version}`;
    const matches = [...physicalResolutions].filter((value) => value.startsWith(`${entry.name}@`));
    const packageEntry = record(packages[physicalLocator], `${entry.name} package`);
    const resolution = record(packageEntry["resolution"], `${entry.name} resolution`);
    if (matches.length !== 1 || matches[0] !== physicalLocator ||
      resolution["integrity"] !== entry.integrity) {
      fail(`${entry.name} runtime closure coordinate differs from the Cohort.`);
    }
  }
  managedEdges.sort(compareEdges);
  if (canonicalConsumerIntegrationJson(managedEdges) !==
    canonicalConsumerIntegrationJson(QUALIFIED_DOCS_COHORT_V2_EDGES.toSorted(compareEdges))) {
    fail("Runtime closure v2 internal dependency edges are not exactly closed.");
  }
  return { locators, managedEdges };
}

/** V2 binds raw peer-qualified snapshots; V1's type-only peer normalization is historical. */
export function computePnpmRuntimeClosureDigestV2(
  lock: JsonRecord,
  cohort: QualifiedDocsCohortBindingV2
): `sha256:${string}` {
  if (String(lock["lockfileVersion"]) !== LOCKFILE_VERSION) {
    fail("Runtime closure requires pnpm lockfileVersion 9.0.");
  }
  const importers = record(lock["importers"], "Runtime closure importers");
  const packages = record(lock["packages"], "Runtime closure packages");
  const snapshots = record(lock["snapshots"], "Runtime closure snapshots");
  const root = record(importers["."], "Runtime closure root importer");
  const expected = qualifiedDocsCohortV2PackageEntries(cohort);
  const roots: ClosureEdge[] = [];
  for (const entry of expected) {
    const bindings = binding(root, entry.name);
    if (!entry.direct) {
      if (bindings.length !== 0) {
        fail(`${entry.name} must remain transitive in the v2 root importer.`);
      }
      continue;
    }
    if (bindings.length !== 1) {
      fail(`${entry.name} runtime closure root binding is not exact.`);
    }
    const selected = record(bindings[0], `${entry.name} runtime closure root binding`);
    if (selected["specifier"] !== entry.version) {
      fail(`${entry.name} runtime closure root binding is not exact.`);
    }
    const value = locator(entry.name, selected["version"], `${entry.name} runtime closure root`);
    if (value.split("(", 1)[0] !== `${entry.name}@${entry.version}`) {
      fail(`${entry.name} runtime closure root version differs from the Cohort.`);
    }
    roots.push({ name: entry.name, locator: value });
  }
  const closure = projectRuntimeClosure(packages, snapshots, roots, expected);
  roots.sort(({ name: left }, { name: right }) => left.localeCompare(right));
  const physicalLocators = [...new Set(closure.locators.map((value) => value.split("(", 1)[0]!))];
  const pnpmLock = {
    lockfileVersion: LOCKFILE_VERSION,
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { ".": { devDependencies: Object.fromEntries(roots.map(({ name, locator: value }) => [
      name,
      {
        specifier: expected.find((entry) => entry.name === name)!.version,
        version: value.slice(`${name}@`.length)
      }
    ])) } },
    packages: Object.fromEntries(physicalLocators.map((value) => [value, packages[value]])),
    snapshots: Object.fromEntries(closure.locators.map((value) => [value, snapshots[value]]))
  };
  const source = `${canonicalConsumerIntegrationJson({
    domain: "agent-teams.docs-runtime-closure/v2",
    schemaVersion: 2,
    packageManager: PACKAGE_MANAGER,
    packageCount: closure.locators.length,
    coordinates: expected.map(({ name, direct, version, integrity }) => ({
      name, role: direct ? "direct" : "transitive", version, integrity
    })),
    managedEdges: closure.managedEdges,
    pnpmLock
  })}\n`;
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_BYTES) {
    fail(`Runtime closure evidence exceeds ${MAXIMUM_BYTES} bytes.`);
  }
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
