import { parseDocument } from "yaml";

import type { ConsumerIntegrationDesiredStateV1 } from "../domain/model.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { targetsManagedPackage, validPnpmPeerContext } from "./pnpm-lockfile-policy-v1.js";
import {
  computePnpmRuntimeClosureDigestV1,
  PnpmRuntimeClosureError
} from "./pnpm-runtime-closure-v1.js";

function yamlRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_INVALID",
      `${subject} must be one mapping.`
    );
  }
  return value as Record<string, unknown>;
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

function assertRegistryBoundRuntimeClosure(
  lockfile: Record<string, unknown>,
  desired: ConsumerIntegrationDesiredStateV1
): void {
  try {
    // The Cohort digest qualifies the isolated release graph. A consumer may select
    // compatible transitives or peer contexts, but every reachable edge stays registry/SRI bound.
    computePnpmRuntimeClosureDigestV1(lockfile, desired.cohort);
  } catch (error) {
    if (error instanceof PnpmRuntimeClosureError) {
      throw new ConsumerIntegrationNodeError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

export function assertQualifiedPnpmLockfileV1(
  bytes: Uint8Array,
  desired: ConsumerIntegrationDesiredStateV1
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
      "V1 requires pnpm lockfileVersion 9.0."
    );
  }
  if (targetsManagedPackage(lockfile["overrides"]) ||
    targetsManagedPackage(lockfile["patchedDependencies"])) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_LOCKFILE_OVERRIDE",
      "Docs Protocol cohort packages must not use lockfile overrides or patches."
    );
  }
  const importers = yamlRecord(lockfile["importers"], "pnpm-lock.yaml#importers");
  if (importers["."] === undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_WORKSPACE",
      "V1 requires one root pnpm importer in the repository lockfile."
    );
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
    if (["@agent-teams/docs-protocol", "@agent-teams/engineering-foundation"]
      .some((packageName) => record[packageName] !== undefined)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_NON_DEV_DEPENDENCY",
        "Docs Protocol cohort packages may be declared only in root devDependencies."
      );
    }
  }
  const packages = yamlRecord(lockfile["packages"], "pnpm-lock.yaml#packages");
  const snapshots = yamlRecord(lockfile["snapshots"], "pnpm-lock.yaml#snapshots");
  const targets = [
    ["@agent-teams/docs-protocol", desired.cohort.packages.docsProtocol],
    ["@agent-teams/engineering-foundation", desired.cohort.packages.engineeringFoundation]
  ] as const;
  assertRootOwnsCohortPins(importers, targets.map(([packageName]) => packageName));
  for (const [packageName, target] of targets) {
    const importerEntry = yamlRecord(
      devDependencies[packageName],
      `pnpm-lock.yaml#importers...${packageName}`
    );
    const selectedVersion = importerEntry["version"];
    if (importerEntry["specifier"] !== target.version ||
      !validPnpmPeerContext(selectedVersion, target.version)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_LOCKFILE_COHORT_MISMATCH",
        `${packageName} importer evidence must select exact cohort version ${target.version}.`
      );
    }
    const packageEntry = yamlRecord(
      packages[`${packageName}@${target.version}`],
      `pnpm-lock.yaml#packages.${packageName}`
    );
    assertRegistryPackageEntry({ integrity: target.integrity, packageEntry, packageName });
    const snapshotKey = `${packageName}@${selectedVersion}`;
    if (snapshots[snapshotKey] === undefined) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_LOCKFILE_SNAPSHOT_MISSING",
        `${packageName} must have the exact selected pnpm snapshot.`
      );
    }
  }
  for (const [packageName, target] of targets) {
    const prefix = `${packageName}@`;
    const keys = Object.keys(packages).filter((key) => key.startsWith(prefix));
    if (keys.length !== 1 || keys[0] !== `${prefix}${target.version}`) {
      throw new ConsumerIntegrationNodeError(
        packageName.endsWith("engineering-foundation")
          ? "DOCS_CONSUMER_DUPLICATE_FOUNDATION_RESOLUTION"
          : "DOCS_CONSUMER_DUPLICATE_DOCS_PROTOCOL_RESOLUTION",
        `pnpm-lock.yaml must contain exactly one physical cohort ${packageName} resolution.`
      );
    }
  }
  const docsSelection = yamlRecord(
    devDependencies["@agent-teams/docs-protocol"],
    "pnpm-lock.yaml#importers...docs-protocol"
  )["version"];
  const docsSnapshot = yamlRecord(
    snapshots[`@agent-teams/docs-protocol@${String(docsSelection)}`],
    "pnpm-lock.yaml#snapshots.docs-protocol"
  );
  const docsDependencies = yamlRecord(
    docsSnapshot["dependencies"],
    "pnpm-lock.yaml#snapshots.docs-protocol.dependencies"
  );
  if (!validPnpmPeerContext(
    docsDependencies["@agent-teams/engineering-foundation"],
    desired.cohort.packages.engineeringFoundation.version
  )) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH",
      "The selected Docs Protocol snapshot must depend on the exact cohort Foundation version."
    );
  }
  assertRegistryBoundRuntimeClosure(lockfile, desired);
}
