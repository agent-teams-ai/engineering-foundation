import { parseDocument } from "yaml";

import type { ConsumerIntegrationDesiredStateV1 } from "../domain/model.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { targetsManagedPackage, validPnpmPeerContext } from "./pnpm-lockfile-policy-v1.js";
import {
  computePnpmRuntimeClosureDigestV1,
  PnpmRuntimeClosureError
} from "./pnpm-runtime-closure-v1.js";

export interface QualifiedPnpmLockfileTarget {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly direct?: boolean;
}

export interface QualifiedPnpmLockfileInternalEdge {
  readonly from: string;
  readonly to: string;
}

function yamlRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      `${subject} must be one mapping.`
    );
  }
  return value as Record<string, unknown>;
}

function yamlOptionalRecord(value: unknown, subject: string): Record<string, unknown> {
  return value === undefined ? {} : yamlRecord(value, subject);
}

function assertRegistryPackageEntry(options: {
  readonly integrity: string;
  readonly packageEntry: Record<string, unknown>;
  readonly packageName: string;
}): void {
  const resolution = yamlRecord(
    options.packageEntry["resolution"],
    `pnpm-lock.yaml#packages.${options.packageName}.resolution`
  );
  if (resolution["integrity"] !== options.integrity) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INTEGRITY_MISMATCH",
      `${options.packageName} registry integrity does not match the selected cohort.`
    );
  }
  const tarball = resolution["tarball"];
  if (typeof tarball === "string" && !tarball.startsWith("https://registry.npmjs.org/")) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_SOURCE_INVALID",
      `${options.packageName} must resolve from registry.npmjs.org.`
    );
  }
}

function assertRootOwnsCohortPins(
  importers: Record<string, unknown>,
  packageNames: readonly string[]
): void {
  for (const [importerPath, importerValue] of Object.entries(importers)) {
    if (importerPath === ".") {continue;}
    const nestedImporter = yamlRecord(importerValue, `pnpm-lock.yaml#importers.${importerPath}`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const declarations = nestedImporter[field];
      if (declarations === undefined) {continue;}
      const record = yamlRecord(declarations, `pnpm-lock.yaml#importers.${importerPath}.${field}`);
      if (packageNames.some((packageName) => record[packageName] !== undefined)) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_NESTED_IMPORTER_PIN_FORBIDDEN",
          `Only the root importer may own Docs Protocol cohort pins; found one in ${importerPath}.`
        );
      }
    }
  }
}

function targetsNpmAlias(value: unknown, packageNames: readonly string[]): boolean {
  const candidates = typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null && !Array.isArray(value)
      ? [
          (value as Record<string, unknown>)["specifier"],
          (value as Record<string, unknown>)["version"]
        ]
      : [];
  return candidates.some((candidate) => typeof candidate === "string" &&
    packageNames.some((packageName) =>
      candidate === `npm:${packageName}` || candidate.startsWith(`npm:${packageName}@`) ||
      candidate === packageName || candidate.startsWith(`${packageName}@`)
    ));
}

function assertNoCohortAliases(
  importers: Record<string, unknown>,
  packageNames: readonly string[]
): void {
  for (const [importerPath, importerValue] of Object.entries(importers)) {
    const importer = yamlRecord(importerValue, `pnpm-lock.yaml#importers.${importerPath}`);
    for (const field of [
      "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"
    ]) {
      if (importer[field] === undefined) {continue;}
      const declarations = yamlRecord(
        importer[field],
        `pnpm-lock.yaml#importers.${importerPath}.${field}`
      );
      for (const [alias, declaration] of Object.entries(declarations)) {
        if (targetsNpmAlias(declaration, packageNames)) {
          throw new ConsumerIntegrationNodeError(
            "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN",
            `pnpm importer ${importerPath} alias ${alias} must not target a Cohort package.`
          );
        }
      }
    }
  }
}

function assertRegistryBoundRuntimeClosure(
  lockfile: Record<string, unknown>,
  compute: (lockfile: Record<string, unknown>) => `sha256:${string}`,
  expectedDigest: string,
  enforceDigest: boolean
): void {
  try {
    // The Cohort digest qualifies the isolated release graph. A consumer may select
    // compatible transitives or peer contexts, but every reachable edge stays registry/SRI bound.
    const observedDigest = compute(lockfile);
    if (enforceDigest && observedDigest !== expectedDigest) {
      throw new PnpmRuntimeClosureError(
        "Runtime closure digest differs from the selected Cohort."
      );
    }
  } catch (error) {
    if (error instanceof PnpmRuntimeClosureError) {
      throw new ConsumerIntegrationNodeError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

function assertTargetSnapshots(input: {
  readonly devDependencies: Record<string, unknown>;
  readonly packages: Record<string, unknown>;
  readonly snapshots: Record<string, unknown>;
  readonly targets: readonly QualifiedPnpmLockfileTarget[];
}): ReadonlyMap<string, ReadonlySet<string>> {
  const snapshotKeys = new Map<string, Set<string>>();
  for (const target of input.targets) {
    const packageName = target.name;
    const direct = target.direct ?? true;
    snapshotKeys.set(packageName, new Set<string>());
    const importerValue = input.devDependencies[packageName];
    if (!direct && importerValue !== undefined) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_LOCKFILE_COHORT_MISMATCH",
        `${packageName} is a transitive Cohort coordinate and must not be a root importer pin.`
      );
    }
    if (direct) {
      const importerEntry = yamlRecord(
        importerValue,
        `pnpm-lock.yaml#importers...${packageName}`
      );
      if (importerEntry["specifier"] !== target.version ||
        !validPnpmPeerContext(importerEntry["version"], target.version)) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_LOCKFILE_COHORT_MISMATCH",
          `${packageName} importer evidence must select exact cohort version ${target.version}.`
        );
      }
      const snapshotKey = `${packageName}@${String(importerEntry["version"])}`;
      if (input.snapshots[snapshotKey] === undefined) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_LOCKFILE_SNAPSHOT_MISSING",
          `${packageName} has no snapshot selected by the root importer.`
        );
      }
      snapshotKeys.get(packageName)!.add(snapshotKey);
    }
    const packageEntry = yamlRecord(
      input.packages[`${packageName}@${target.version}`],
      `pnpm-lock.yaml#packages.${packageName}`
    );
    assertRegistryPackageEntry({ integrity: target.integrity, packageEntry, packageName });
  }
  return snapshotKeys;
}

function assertSinglePackageResolutions(
  packages: Record<string, unknown>,
  targets: readonly QualifiedPnpmLockfileTarget[]
): void {
  for (const target of targets) {
    const packageName = target.name;
    const prefix = `${packageName}@`;
    const keys = Object.keys(packages).filter((key) => key.startsWith(prefix));
    if (keys.length !== 1 || keys[0] !== `${prefix}${target.version}`) {
      throw new ConsumerIntegrationNodeError(
        packageName.endsWith("engineering-foundation")
          ? "DOCS_CONSUMER_DUPLICATE_FOUNDATION_RESOLUTION"
          : packageName.endsWith("docs-protocol")
            ? "DOCS_CONSUMER_DUPLICATE_DOCS_PROTOCOL_RESOLUTION"
            : "DOCS_CONSUMER_DUPLICATE_COHORT_RESOLUTION",
        `pnpm-lock.yaml must contain exactly one physical cohort ${packageName} resolution.`
      );
    }
  }
}

function assertInternalEdges(input: {
  readonly edges: readonly QualifiedPnpmLockfileInternalEdge[];
  readonly snapshots: Record<string, unknown>;
  readonly snapshotKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly targets: readonly QualifiedPnpmLockfileTarget[];
}): void {
  const targetByName = new Map(input.targets.map((target) => [target.name, target]));
  const allowedTargetsBySource = new Map<string, Set<string>>();
  for (const edge of input.edges) {
    const source = targetByName.get(edge.from);
    const target = targetByName.get(edge.to);
    if (source === undefined || target === undefined) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH",
        `Internal Cohort edge ${edge.from} -> ${edge.to} has no declared coordinate.`
      );
    }
    const allowedTargets = allowedTargetsBySource.get(source.name) ?? new Set<string>();
    allowedTargets.add(target.name);
    allowedTargetsBySource.set(source.name, allowedTargets);
  }

  const selectedSnapshots = new Map(
    [...input.snapshotKeys].map(([name, keys]) => [name, new Set(keys)])
  );
  const pending = input.targets.flatMap((target) =>
    [...(selectedSnapshots.get(target.name) ?? [])].map((snapshotKey) => ({
      source: target,
      snapshotKey
    }))
  );
  const visited = new Set<string>();
  while (pending.length > 0) {
    const { source, snapshotKey } = pending.shift()!;
    if (visited.has(snapshotKey)) {continue;}
    visited.add(snapshotKey);
    const sourceSnapshot = yamlRecord(
      input.snapshots[snapshotKey],
      `pnpm-lock.yaml#snapshots.${snapshotKey}`
    );
    const dependencies = yamlOptionalRecord(
      sourceSnapshot["dependencies"],
      `pnpm-lock.yaml#snapshots.${source.name}.dependencies`
    );
    const optionalDependencies = yamlOptionalRecord(
      sourceSnapshot["optionalDependencies"],
      `pnpm-lock.yaml#snapshots.${source.name}.optionalDependencies`
    );
    const allowedTargets = allowedTargetsBySource.get(source.name) ?? new Set<string>();
    for (const target of input.targets) {
      const dependency = dependencies[target.name];
      const optionalDependency = optionalDependencies[target.name];
      if (optionalDependency !== undefined) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH",
          `${source.name} must not optionally depend on Cohort package ${target.name}.`
        );
      }
      if (allowedTargets.has(target.name)) {
        if (!validPnpmPeerContext(dependency, target.version)) {
          throw new ConsumerIntegrationNodeError(
            "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH",
            `${source.name} must depend on exact Cohort ${target.name}@${target.version}.`
          );
        }
        const targetSnapshotKey = `${target.name}@${String(dependency)}`;
        if (input.snapshots[targetSnapshotKey] === undefined) {
          throw new ConsumerIntegrationNodeError(
            "DOCS_CONSUMER_LOCKFILE_SNAPSHOT_MISSING",
            `${source.name} selects missing Cohort snapshot ${targetSnapshotKey}.`
          );
        }
        const targetSelections = selectedSnapshots.get(target.name)!;
        if (!targetSelections.has(targetSnapshotKey)) {
          targetSelections.add(targetSnapshotKey);
          pending.push({ source: target, snapshotKey: targetSnapshotKey });
        }
      } else if (dependency !== undefined) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH",
          `${source.name} has forbidden extra Cohort dependency ${target.name}.`
        );
      }
    }
  }
  for (const target of input.targets) {
    if ((selectedSnapshots.get(target.name)?.size ?? 0) === 0) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_LOCKFILE_SNAPSHOT_MISSING",
        `${target.name} has no snapshot reachable from the root Cohort pins.`
      );
    }
  }
}

export function assertQualifiedPnpmLockfileTargets(
  bytes: Uint8Array,
  options: {
    readonly targets: readonly QualifiedPnpmLockfileTarget[];
    readonly internalEdges: readonly QualifiedPnpmLockfileInternalEdge[];
    readonly runtimeClosureDigest: string;
    readonly computeRuntimeClosureDigest: (
      lockfile: Record<string, unknown>
    ) => `sha256:${string}`;
    readonly forbiddenAliasTargetPackageNames?: readonly string[];
    /** V1 historically validates closure safety without binding the consumer's full graph digest. */
    readonly enforceRuntimeClosureDigest?: boolean;
  }
): void {
  const document = parseDocument(Buffer.from(bytes).toString("utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      "pnpm-lock.yaml must be duplicate-free YAML."
    );
  }
  const lockfile = yamlRecord(document.toJS({ maxAliasCount: 0 }), "pnpm-lock.yaml");
  if (String(lockfile["lockfileVersion"]) !== "9.0") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      "Managed consumer integration requires pnpm lockfileVersion 9.0."
    );
  }
  const targetPackageNames = options.targets.map(({ name }) => name);
  if (targetsManagedPackage(lockfile["overrides"], targetPackageNames) ||
    targetsManagedPackage(lockfile["patchedDependencies"], targetPackageNames)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_OVERRIDE",
      "Docs Protocol cohort packages must not use lockfile overrides or patches."
    );
  }
  const importers = yamlRecord(lockfile["importers"], "pnpm-lock.yaml#importers");
  if (importers["."] === undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_WORKSPACE",
      "Managed consumer integration requires one root pnpm importer."
    );
  }
  const forbiddenAliasTargetPackageNames = options.forbiddenAliasTargetPackageNames ?? [];
  if (forbiddenAliasTargetPackageNames.length > 0) {
    assertNoCohortAliases(importers, forbiddenAliasTargetPackageNames);
  }
  const importer = yamlRecord(importers["."], "pnpm-lock.yaml#importers.");
  const devDependencies = yamlRecord(
    importer["devDependencies"],
    "pnpm-lock.yaml#importers...devDependencies"
  );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const declarations = importer[field];
    if (declarations === undefined) {continue;}
    const record = yamlRecord(declarations, `pnpm-lock.yaml#importers...${field}`);
    if (targetPackageNames.some((packageName) => record[packageName] !== undefined)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_NON_DEV_DEPENDENCY",
        "Docs Protocol cohort packages may be declared only in root devDependencies."
      );
    }
  }
  const packages = yamlRecord(lockfile["packages"], "pnpm-lock.yaml#packages");
  const snapshots = yamlRecord(lockfile["snapshots"], "pnpm-lock.yaml#snapshots");
  assertRootOwnsCohortPins(importers, targetPackageNames);
  const snapshotKeys = assertTargetSnapshots({
    devDependencies,
    packages,
    snapshots,
    targets: options.targets
  });
  assertSinglePackageResolutions(packages, options.targets);
  assertInternalEdges({
    edges: options.internalEdges,
    snapshots,
    snapshotKeys,
    targets: options.targets
  });
  assertRegistryBoundRuntimeClosure(
    lockfile,
    options.computeRuntimeClosureDigest,
    options.runtimeClosureDigest,
    options.enforceRuntimeClosureDigest ?? true
  );
}

export function assertQualifiedPnpmLockfileV1(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV1
): void {
  assertQualifiedPnpmLockfileTargets(bytes, {
    targets: [
      { name: "@agent-teams/docs-protocol", ...desired.cohort.packages.docsProtocol },
      {
        name: "@agent-teams/engineering-foundation",
        ...desired.cohort.packages.engineeringFoundation
      }
    ],
    internalEdges: [{
      from: "@agent-teams/docs-protocol",
      to: "@agent-teams/engineering-foundation"
    }],
    runtimeClosureDigest: desired.cohort.runtime.runtimeClosureDigest,
    enforceRuntimeClosureDigest: false,
    computeRuntimeClosureDigest: (lockfile) =>
      computePnpmRuntimeClosureDigestV1(lockfile, desired.cohort)
  });
}
