import { isExactVersion } from "../../semantic-version.js";
import type { ConsumerPolicyInspection } from "./model.js";
import { FOUNDATION_PACKAGE_NAME } from "./model.js";

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

function inspectDependencyPlacement(
  manifest: Record<string, unknown> | undefined,
  issues: string[]
): string | undefined {
  const candidate = dependencyValue(
    manifest?.devDependencies,
    FOUNDATION_PACKAGE_NAME
  );
  const dependencySpec = typeof candidate === "string" ? candidate : undefined;
  if (dependencySpec === undefined) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must be declared in devDependencies.`);
  } else if (!isExactVersion(dependencySpec)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must use an exact registry version.`);
  }
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    if (dependencyValue(manifest?.[field], FOUNDATION_PACKAGE_NAME) !== undefined) {
      issues.push(`${FOUNDATION_PACKAGE_NAME} must not be declared in ${field}.`);
    }
  }
  if (
    hasBundledFoundation(manifest?.bundleDependencies) ||
    hasBundledFoundation(manifest?.bundledDependencies)
  ) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not be bundled for runtime.`);
  }
  return dependencySpec;
}

function inspectDependencyOverrides(
  manifest: Record<string, unknown> | undefined,
  issues: string[]
): void {
  if (targetsFoundation(manifest?.overrides)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not use npm overrides.`);
  }
  if (targetsFoundation(manifest?.resolutions)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not use dependency resolutions.`);
  }
  if (!isRecord(manifest?.pnpm)) {
    return;
  }
  if (targetsFoundation(manifest.pnpm.overrides)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not use pnpm overrides.`);
  }
  if (targetsFoundation(manifest.pnpm.patchedDependencies)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must not use pnpm patches.`);
  }
}

export function inspectConsumerManifest(
  consumerRoot: string,
  manifest: Record<string, unknown> | undefined,
  inputIssues: readonly string[] = []
): ConsumerPolicyInspection {
  const issues = [...inputIssues];
  const dependencySpec = inspectDependencyPlacement(manifest, issues);
  inspectDependencyOverrides(manifest, issues);

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

export interface LockfileProvenanceInspection {
  readonly packageKey?: string;
  readonly snapshotKey?: string;
  readonly integrity?: string;
  readonly issues: readonly string[];
}

function inspectLockfileMetadata(
  lockfile: Record<string, unknown>,
  source: string,
  issues: string[]
): void {
  if (lockfile.lockfileVersion !== "9.0") {
    issues.push(`${source} must use pnpm lockfileVersion 9.0.`);
  }
  if (targetsFoundation(lockfile.overrides)) {
    issues.push(`${source} must not use lockfile overrides.`);
  }
  if (targetsFoundation(lockfile.patchedDependencies)) {
    issues.push(`${source} must not use lockfile patches.`);
  }
}

function inspectRuntimeImporterDependencies(
  rootImporter: Record<string, unknown>,
  source: string,
  issues: string[]
): void {
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    if (dependencyValue(rootImporter[field], FOUNDATION_PACKAGE_NAME) !== undefined) {
      issues.push(`${FOUNDATION_PACKAGE_NAME} must not resolve through ${source} ${field}.`);
    }
  }
}

function inspectRegistryResolution(
  lockfile: Record<string, unknown>,
  source: string,
  packageKey: string,
  issues: string[]
): string | undefined {
  const packageEntry = isRecord(lockfile.packages)
    ? lockfile.packages[packageKey]
    : undefined;
  if (!isRecord(packageEntry) || !isRecord(packageEntry.resolution)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must have an npm registry package entry in ${source}.`);
    return undefined;
  }
  const resolution = packageEntry.resolution;
  const integrity = typeof resolution.integrity === "string"
    ? resolution.integrity
    : undefined;
  if (integrity === undefined || !SHA512_INTEGRITY_PATTERN.test(integrity)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} ${source} entry must contain sha512 registry integrity.`);
  }
  const tarball = typeof resolution.tarball === "string" ? resolution.tarball : undefined;
  if (tarball !== undefined && !tarball.startsWith("https://registry.npmjs.org/")) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} ${source} tarball must come from registry.npmjs.org.`);
  }
  for (const field of ["commit", "directory", "path", "repo", "type"]) {
    if (resolution[field] !== undefined) {
      issues.push(`${FOUNDATION_PACKAGE_NAME} ${source} resolution contains forbidden field ${field}.`);
    }
  }
  return integrity;
}

export function inspectLockfile(
  lockfile: Record<string, unknown>,
  source: string,
  dependencySpec: string | undefined
): LockfileProvenanceInspection {
  const issues: string[] = [];
  inspectLockfileMetadata(lockfile, source, issues);
  const rootImporter = isRecord(lockfile.importers) ? lockfile.importers["."] : undefined;
  if (!isRecord(rootImporter)) {
    issues.push(`${source} must contain the root importer.`);
    return { issues };
  }
  inspectRuntimeImporterDependencies(rootImporter, source, issues);
  const lockedDependency = dependencyValue(
    rootImporter.devDependencies,
    FOUNDATION_PACKAGE_NAME
  );
  if (!isRecord(lockedDependency)) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must be locked in ${source} root devDependencies.`);
    return { issues };
  }
  if (
    dependencySpec === undefined ||
    lockedDependency.specifier !== dependencySpec ||
    !hasValidPnpmPeerContext(lockedDependency.version, dependencySpec)
  ) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} ${source} specifier must equal the exact manifest version and its version may contain only a valid pnpm peer context.`);
    return { issues };
  }
  const packageKey = `${FOUNDATION_PACKAGE_NAME}@${dependencySpec}`;
  const snapshotKey = `${FOUNDATION_PACKAGE_NAME}@${lockedDependency.version}`;
  const integrity = inspectRegistryResolution(lockfile, source, packageKey, issues);
  if (!isRecord(lockfile.snapshots) || !isRecord(lockfile.snapshots[snapshotKey])) {
    issues.push(`${FOUNDATION_PACKAGE_NAME} must have an exact snapshot entry in ${source}.`);
  }
  return {
    packageKey,
    snapshotKey,
    ...(integrity === undefined ? {} : { integrity }),
    issues
  };
}
