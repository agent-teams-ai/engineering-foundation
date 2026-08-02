import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseDocument } from "yaml";

import { isExactVersion } from "../semantic-version.js";
import type {
  FoundationDevOnlyStatus,
  FoundationRegistryProvenance
} from "./types.js";
import { FOUNDATION_PACKAGE_NAME } from "./types.js";

interface ConsumerPolicyInspection extends FoundationDevOnlyStatus {
  readonly packageManager?: string;
}

interface RegistryProvenanceInspection {
  readonly provenance?: FoundationRegistryProvenance;
  readonly issues: readonly string[];
}

const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyValue(
  container: unknown,
  dependencyName: string
): unknown {
  return isRecord(container) ? container[dependencyName] : undefined;
}

function targetsFoundation(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key.includes(FOUNDATION_PACKAGE_NAME));
}

function hasBundledFoundation(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((candidate) => candidate === FOUNDATION_PACKAGE_NAME)
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function inspectFoundationDevOnly(
  consumerRoot: string
): Promise<ConsumerPolicyInspection> {
  const issues: string[] = [];
  let manifest: Record<string, unknown> | undefined;
  try {
    const candidate = await readJson(join(consumerRoot, "package.json"));
    if (isRecord(candidate)) {
      manifest = candidate;
    } else {
      issues.push("Consumer package.json must contain an object.");
    }
  } catch {
    issues.push("Consumer package.json cannot be read.");
  }

  const dependencyCandidate = dependencyValue(
    manifest?.devDependencies,
    FOUNDATION_PACKAGE_NAME
  );
  const dependencySpec =
    typeof dependencyCandidate === "string" ? dependencyCandidate : undefined;
  if (dependencySpec === undefined) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must be declared in devDependencies.`);
  } else if (!isExactVersion(dependencySpec)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must use an exact registry version.`);
  }

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    if (dependencyValue(manifest?.[field], FOUNDATION_PACKAGE_NAME) !== undefined) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} must not be declared in ${field}.`
      );
    }
  }
  if (
    hasBundledFoundation(manifest?.bundleDependencies) ||
    hasBundledFoundation(manifest?.bundledDependencies)
  ) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not be bundled for runtime.`);
  }

  if (targetsFoundation(manifest?.overrides)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not use npm overrides.`);
  }
  if (targetsFoundation(manifest?.resolutions)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not use dependency resolutions.`);
  }
  if (isRecord(manifest?.pnpm)) {
    if (targetsFoundation(manifest.pnpm.overrides)) {
      issues.push(`${FOUNDATION_PACKAGE_NAME} must not use pnpm overrides.`);
    }
    if (targetsFoundation(manifest.pnpm.patchedDependencies)) {
      issues.push(`${FOUNDATION_PACKAGE_NAME} must not use pnpm patches.`);
    }
  }

  const packageManager =
    typeof manifest?.packageManager === "string"
      ? manifest.packageManager
      : undefined;
  if (
    packageManager === undefined ||
    !/^pnpm@11\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageManager)
  ) {
    issues.push("Consumer packageManager must pin an exact pnpm 11 version.");
  }

  return {
    consumerRoot,
    ...(dependencySpec === undefined ? {} : { dependencySpec }),
    ...(packageManager === undefined ? {} : { packageManager }),
    issues
  };
}

function readLockfileObject(source: string): Record<string, unknown> {
  const document = parseDocument(source, {
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(value)) {
    throw new Error("pnpm-lock.yaml must contain an object.");
  }
  return value;
}

function hasValidPnpmPeerContext(
  lockedVersion: unknown,
  exactVersion: string
): lockedVersion is string {
  if (lockedVersion === exactVersion) {
    return true;
  }
  if (
    typeof lockedVersion !== "string" ||
    !lockedVersion.startsWith(`${exactVersion}(`)
  ) {
    return false;
  }

  const suffix = lockedVersion.slice(exactVersion.length);
  const contentByDepth: boolean[] = [];
  for (const character of suffix) {
    if (character === "(") {
      contentByDepth.push(false);
      continue;
    }
    if (character === ")") {
      if (contentByDepth.pop() !== true) {
        return false;
      }
      if (contentByDepth.length > 0) {
        contentByDepth[contentByDepth.length - 1] = true;
      }
      continue;
    }
    if (contentByDepth.length === 0 || /\s/u.test(character)) {
      return false;
    }
    contentByDepth[contentByDepth.length - 1] = true;
  }
  return contentByDepth.length === 0;
}

export async function inspectFoundationRegistryProvenance(
  consumerRoot: string,
  dependencySpec: string | undefined
): Promise<RegistryProvenanceInspection> {
  const inspectLockfile = (
    lockfile: Record<string, unknown>,
    source: string
  ): {
    readonly packageKey?: string;
    readonly snapshotKey?: string;
    readonly integrity?: string;
    readonly issues: readonly string[];
  } => {
    const issues: string[] = [];
    if (lockfile.lockfileVersion !== "9.0") {
      issues.push(`${source} must use pnpm lockfileVersion 9.0.`);
    }
    if (targetsFoundation(lockfile.overrides)) {
      issues.push(`${source} must not use lockfile overrides.`);
    }
    if (targetsFoundation(lockfile.patchedDependencies)) {
      issues.push(`${source} must not use lockfile patches.`);
    }

    const rootImporter = isRecord(lockfile.importers)
      ? lockfile.importers["."]
      : undefined;
    if (!isRecord(rootImporter)) {
      issues.push(`${source} must contain the root importer.`);
      return { issues };
    }
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      if (
        dependencyValue(rootImporter[field], FOUNDATION_PACKAGE_NAME) !==
        undefined
      ) {
        issues.push(
          `${FOUNDATION_PACKAGE_NAME} must not resolve through ${source} ${field}.`
        );
      }
    }

    const lockedDependency = dependencyValue(
      rootImporter.devDependencies,
      FOUNDATION_PACKAGE_NAME
    );
    if (!isRecord(lockedDependency)) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} must be locked in ${source} root devDependencies.`
      );
      return { issues };
    }
    if (
      dependencySpec === undefined ||
      lockedDependency.specifier !== dependencySpec ||
      !hasValidPnpmPeerContext(lockedDependency.version, dependencySpec)
    ) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} ${source} specifier must equal the exact manifest version and its version may contain only a valid pnpm peer context.`
      );
      return { issues };
    }

    const packageKey = `${FOUNDATION_PACKAGE_NAME}@${dependencySpec}`;
    const snapshotKey = `${FOUNDATION_PACKAGE_NAME}@${lockedDependency.version}`;
    const packageEntry = isRecord(lockfile.packages)
      ? lockfile.packages[packageKey]
      : undefined;
    if (!isRecord(packageEntry) || !isRecord(packageEntry.resolution)) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} must have an npm registry package entry in ${source}.`
      );
      return { issues };
    }
    const resolution = packageEntry.resolution;
    const integrity =
      typeof resolution.integrity === "string"
        ? resolution.integrity
        : undefined;
    if (integrity === undefined || !SHA512_INTEGRITY_PATTERN.test(integrity)) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} ${source} entry must contain sha512 registry integrity.`
      );
    }
    const tarball =
      typeof resolution.tarball === "string" ? resolution.tarball : undefined;
    if (
      tarball !== undefined &&
      !tarball.startsWith("https://registry.npmjs.org/")
    ) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} ${source} tarball must come from registry.npmjs.org.`
      );
    }
    for (const forbiddenField of [
      "commit",
      "directory",
      "path",
      "repo",
      "type"
    ]) {
      if (resolution[forbiddenField] !== undefined) {
        issues.push(
          `${FOUNDATION_PACKAGE_NAME} ${source} resolution contains forbidden field ${forbiddenField}.`
        );
      }
    }
    if (
      !isRecord(lockfile.snapshots) ||
      !isRecord(lockfile.snapshots[snapshotKey])
    ) {
      issues.push(
        `${FOUNDATION_PACKAGE_NAME} must have an exact snapshot entry in ${source}.`
      );
    }

    return {
      packageKey,
      snapshotKey,
      ...(integrity === undefined ? {} : { integrity }),
      issues
    };
  };

  const issues: string[] = [];
  const lockfilePath = join(consumerRoot, "pnpm-lock.yaml");
  let lockfile: Record<string, unknown>;
  try {
    lockfile = readLockfileObject(await readFile(lockfilePath, "utf8"));
  } catch {
    return {
      issues: ["Consumer pnpm-lock.yaml cannot be parsed safely."]
    };
  }

  const rootProvenance = inspectLockfile(
    lockfile,
    "consumer pnpm-lock.yaml"
  );
  issues.push(...rootProvenance.issues);

  const virtualStoreLockfilePath = join(
    consumerRoot,
    "node_modules",
    ".pnpm",
    "lock.yaml"
  );
  let virtualStoreLockfile: Record<string, unknown>;
  try {
    virtualStoreLockfile = readLockfileObject(
      await readFile(virtualStoreLockfilePath, "utf8")
    );
  } catch {
    issues.push("Installed pnpm virtual-store lockfile cannot be parsed safely.");
    return { issues };
  }
  const installedProvenance = inspectLockfile(
    virtualStoreLockfile,
    "installed pnpm virtual-store lockfile"
  );
  issues.push(...installedProvenance.issues);
  if (
    rootProvenance.packageKey !== installedProvenance.packageKey ||
    rootProvenance.snapshotKey !== installedProvenance.snapshotKey ||
    rootProvenance.integrity !== installedProvenance.integrity
  ) {
    issues.push(
      `${FOUNDATION_PACKAGE_NAME} root and installed pnpm lockfile provenance must match.`
    );
  }

  return {
    ...(issues.length === 0 &&
    rootProvenance.packageKey !== undefined &&
    rootProvenance.integrity !== undefined
      ? {
          provenance: {
            lockfilePath,
            packageKey: rootProvenance.packageKey,
            integrity: rootProvenance.integrity
          }
        }
      : {}),
    issues
  };
}
