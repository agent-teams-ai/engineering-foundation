import { createHash } from "node:crypto";

import type { QualifiedDocsCohortBindingV1 } from "../domain/model.js";
import { canonicalConsumerIntegrationJson } from "../application/policies/consumer-integration-assets.js";

const PACKAGE_MANAGER = "pnpm@11.18.0";
const LOCKFILE_VERSION = "9.0";
const MAXIMUM_PACKAGES = 2048;
const MAXIMUM_DEPTH = 64;
const MAXIMUM_BYTES = 2 * 1024 * 1024;
const REGISTRY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;

type JsonRecord = Record<string, unknown>;

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

function sortedEdges(snapshot: JsonRecord, section: string, label: string): readonly {
  readonly name: string;
  readonly locator: string;
}[] {
  const value = snapshot[section] ?? {};
  const source = record(value, `${label} ${section}`);
  return Object.entries(source)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, raw]) => ({ name, locator: locator(name, raw, `${label} ${section}.${name}`) }));
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

export function computePnpmRuntimeClosureDigestV1(
  lock: JsonRecord,
  cohort: QualifiedDocsCohortBindingV1
): `sha256:${string}` {
  if (String(lock["lockfileVersion"]) !== LOCKFILE_VERSION) {
    fail("Runtime closure requires pnpm lockfileVersion 9.0.");
  }
  const importers = record(lock["importers"], "Runtime closure importers");
  const packages = record(lock["packages"], "Runtime closure packages");
  const snapshots = record(lock["snapshots"], "Runtime closure snapshots");
  const root = record(importers["."], "Runtime closure root importer");
  const expected = packageRoots(cohort);
  const roots = expected.map((entry) => {
    const bindings = binding(root, entry.name);
    if (bindings.length !== 1) {
      fail(`${entry.name} runtime closure root binding is not exact.`);
    }
    const selected = record(bindings[0], `${entry.name} runtime closure root binding`);
    if (selected["specifier"] !== entry.version || typeof selected["version"] !== "string") {
      fail(`${entry.name} runtime closure root binding is not exact.`);
    }
    const selectedLocator = locator(entry.name, selected["version"], `${entry.name} runtime closure root`);
    if (selectedLocator.split("(", 1)[0] !== `${entry.name}@${entry.version}`) {
      fail(`${entry.name} runtime closure root version differs from the Cohort.`);
    }
    const packageEntry = record(packages[`${entry.name}@${entry.version}`], `${entry.name} package`);
    const resolution = record(packageEntry["resolution"], `${entry.name} resolution`);
    if (resolution["integrity"] !== entry.integrity) {
      fail(`${entry.name} runtime closure root integrity differs from the Cohort.`);
    }
    return { name: entry.name, locator: selectedLocator };
  }).toSorted(({ name: left }, { name: right }) => left < right ? -1 : left > right ? 1 : 0);

  const pending = roots.map(({ locator: rootLocator }) => ({ locator: rootLocator, depth: 0 }));
  const visited = new Set<string>();
  const projectedPackages: Array<{
    readonly locator: string;
    readonly integrity: string;
    readonly dependencies: readonly { readonly name: string; readonly locator: string }[];
    readonly optionalDependencies: readonly { readonly name: string; readonly locator: string }[];
  }> = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.locator)) {continue;}
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
    const integrity = resolution["integrity"];
    if (typeof integrity !== "string" || !SHA512_SRI.test(integrity)) {
      fail(`Runtime closure locator ${current.locator} has no exact registry SRI.`);
    }
    const dependencies = sortedEdges(snapshot, "dependencies", current.locator);
    const optionalDependencies = sortedEdges(snapshot, "optionalDependencies", current.locator);
    const edgeByName = new Map<string, string>();
    for (const edge of [...dependencies, ...optionalDependencies]) {
      const prior = edgeByName.get(edge.name);
      if (prior !== undefined && prior !== edge.locator) {
        fail(`Runtime closure locator ${current.locator} has ambiguous dependency ${edge.name}.`);
      }
      edgeByName.set(edge.name, edge.locator);
      pending.push({ locator: edge.locator, depth: current.depth + 1 });
    }
    projectedPackages.push({
      locator: current.locator,
      integrity,
      dependencies,
      optionalDependencies
    });
  }
  projectedPackages.sort(({ locator: left }, { locator: right }) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const projection = {
    schemaVersion: 1,
    packageManager: PACKAGE_MANAGER,
    lockfileVersion: LOCKFILE_VERSION,
    packageCount: projectedPackages.length,
    roots,
    packages: projectedPackages
  };
  if (Buffer.byteLength(canonicalConsumerIntegrationJson(projection), "utf8") > MAXIMUM_BYTES) {
    fail(`Runtime closure projection exceeds ${MAXIMUM_BYTES} bytes.`);
  }
  const physicalLocators = [...new Set(projectedPackages.map(({ locator: value }) =>
    value.split("(", 1)[0]!
  ))].toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0);
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
    snapshots: Object.fromEntries(projectedPackages.map(({ locator: value }) => [value, snapshots[value]]))
  };
  const source = `${canonicalConsumerIntegrationJson({
    domain: "agent-teams.docs-runtime-closure/v1",
    schemaVersion: 1,
    packageManager: PACKAGE_MANAGER,
    packageCount: projectedPackages.length,
    pnpmLock
  })}\n`;
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_BYTES) {
    fail(`Runtime closure evidence exceeds ${MAXIMUM_BYTES} bytes.`);
  }
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
