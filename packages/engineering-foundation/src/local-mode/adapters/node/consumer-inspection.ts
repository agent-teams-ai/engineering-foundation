import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { inspectBunRegistryProvenance, readBoundedConsumerManifest } from "./bun-registry-inspection.js";
import { FoundationError } from "../../../features/validation-reporting/foundation-error.js";
import { inspectConsumerManifest, inspectLockfile, isSupportedPnpmManager } from "../../application/consumer-policy.js";
import type { ConsumerPolicyInspection, RegistryProvenanceInspection } from "../../application/model.js";
import { FOUNDATION_PACKAGE_NAME } from "../../application/model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConsumerManifest(
  consumerRoot: string,
  issues: string[]
): Promise<Record<string, unknown> | undefined> {
  try {
    const candidate = await readBoundedConsumerManifest(consumerRoot);
    if (isRecord(candidate)) {
      return candidate;
    }
    issues.push("Consumer package.json must contain an object.");
  } catch {
    issues.push("Consumer package.json cannot be read as bounded unambiguous JSON.");
  }
  return undefined;
}

export async function inspectFoundationDevOnly(consumerRoot: string): Promise<ConsumerPolicyInspection> {
  const issues: string[] = [];
  const manifest = await readConsumerManifest(consumerRoot, issues);
  return inspectConsumerManifest(consumerRoot, manifest, issues);
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

export async function inspectFoundationRegistryProvenance(
  consumerRoot: string,
  dependencySpec: string | undefined
): Promise<RegistryProvenanceInspection> {
  const consumer = await inspectFoundationDevOnly(consumerRoot);
  if (consumer.packageManager?.startsWith("bun@") === true) {
    if (consumer.issues.length !== 0 || consumer.dependencySpec !== dependencySpec) {
      return { issues: [...consumer.issues, "Bun registry inspection requires the exact admitted manifest dependency."] };
    }
    return inspectBunRegistryProvenance(consumerRoot, dependencySpec);
  }
  if (consumer.packageManager === undefined || !isSupportedPnpmManager(consumer.packageManager)) {
    return { issues: [...consumer.issues, "Registry inspection requires an admitted package manager."] };
  }
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
    "consumer pnpm-lock.yaml",
    dependencySpec
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
    "installed pnpm virtual-store lockfile",
    dependencySpec
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

export async function inspectCanonicalConsumerDevOnly(consumerPath: string): Promise<ConsumerPolicyInspection> {
  return inspectFoundationDevOnly(await realpath(resolve(consumerPath)));
}

/** Concrete Node mutation boundary; abstract lifecycle ports remain manager-neutral. */
export async function assertNodeLocalMutationSupported(consumerPath: string): Promise<void> {
  const consumer = await inspectCanonicalConsumerDevOnly(consumerPath);
  if (consumer.packageManager === undefined || !isSupportedPnpmManager(consumer.packageManager)) {
    throw new FoundationError("CONSUMER_INVALID", "Local attach and detach require pnpm 11; Bun consumers support registry inspection only.");
  }
}
