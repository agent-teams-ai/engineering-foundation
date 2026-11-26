import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationFileObservation,
  ManagedSuccessorProfile,
} from "../application-api.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";
import {
  MAXIMUM_LOCKFILE_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  readStableConsumerFile,
} from "./node-consumer-repository-files.js";

function assertLegacyNodeRuntime(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || (minor ?? 0) < 18) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_NODE",
      "Managed consumer check and plan require Node >=24.18.0 <25.",
    );
  }
}

function platformCoordinate(platform: NodeJS.Platform): "linux" | "macos" | "windows" {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "linux" || platform === "win32") {
    return platform === "win32" ? "windows" : "linux";
  }
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_UNSUPPORTED_NODE",
    `Managed consumer runtime platform is unsupported: ${platform}.`,
  );
}

function assertManagedProfileRuntime(desired: ManagedSuccessorProfile): void {
  const runtime = desired.cohort.runtime;
  const expectedRangeMajor = runtime.selectedLane === "node-26-managed-qualified" ? 26 : 24;
  const [major] = process.versions.node.split(".").map(Number);
  if (
    major !== expectedRangeMajor ||
    process.versions.node !== runtime.qualificationRuntime.nodeVersion ||
    platformCoordinate(process.platform) !== runtime.qualificationRuntime.platform ||
    process.arch !== runtime.qualificationRuntime.architecture
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_NODE",
      "Managed consumer runtime does not match the packed profile4 qualification coordinates.",
    );
  }
}

function assertConsumerRuntime(
  desired: ConsumerIntegrationDesiredState,
  admission: "consumer" | "generation2-source",
): void {
  if (admission === "generation2-source") {
    if (desired.schemaVersion !== 3) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_PROFILE_INVALID",
        "Retained generation2 source observation requires an explicit profile3/Cohort2 source.",
      );
    }
    if (process.versions.node !== "24.21.0") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UNSUPPORTED_NODE",
        "Retained generation2 source observation requires actual Node 24.21.0.",
      );
    }
  } else if (desired.schemaVersion === 4) {
    assertManagedProfileRuntime(desired);
  } else {
    assertLegacyNodeRuntime();
  }
}

function assertPnpmPackageManager(
  packageManager: unknown,
  desired: ConsumerIntegrationDesiredState,
): void {
  const expectedPackageManager =
    desired.schemaVersion === 4
      ? `pnpm@${desired.cohort.runtime.qualificationRuntime.pnpmVersion}`
      : undefined;
  const match =
    desired.schemaVersion === 4
      ? packageManager === expectedPackageManager
      : typeof packageManager === "string" &&
        /^pnpm@(11)\.([0-9]+)\.([0-9]+)(?:\+sha512\.[A-Za-z0-9+/=]+)?$/u.test(packageManager) &&
        Number(/^pnpm@(11)\.([0-9]+)\.([0-9]+)/u.exec(packageManager)?.[2]) >= 17;
  if (!match) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UNSUPPORTED_PACKAGE_MANAGER",
      desired.schemaVersion === 4
        ? "Managed profile4 requires the exact packed pnpm qualification coordinate."
        : "Managed consumer integration requires an exact root packageManager within >=11.17.0 <12.",
    );
  }
}

export async function assertQualifiedPnpmRoot(
  root: string,
  desired: ConsumerIntegrationDesiredState,
  admission: "consumer" | "generation2-source",
): Promise<ConsumerIntegrationFileObservation> {
  assertConsumerRuntime(desired, admission);
  const manifestObservation = await readStableConsumerFile(
    root,
    "package.json",
    MAXIMUM_MANIFEST_BYTES,
    true,
  );
  if (manifestObservation.state !== "file") {
    throw new Error("unreachable");
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = parseJsonRecord(Buffer.from(manifestObservation.bytes).toString("utf8"));
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_MANIFEST_INVALID",
      error instanceof Error ? error.message : "package.json is invalid.",
      { cause: error },
    );
  }
  assertPnpmPackageManager(manifest["packageManager"], desired);
  const nodeVersion = await readStableConsumerFile(root, ".node-version", 128, true);
  const nodePin =
    nodeVersion.state === "file" ? Buffer.from(nodeVersion.bytes).toString("utf8") : undefined;
  const validNodePin =
    desired.schemaVersion === 4
      ? nodePin === `${desired.cohort.runtime.qualificationRuntime.nodeVersion}\n`
      : nodePin !== undefined &&
        (/^24\.(?:1[89]|[2-9][0-9])\.[0-9]+\n?$/u.test(nodePin) ||
          (admission === "generation2-source" && nodePin === "26.11.1\n"));
  if (!validNodePin) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID",
      desired.schemaVersion === 4
        ? ".node-version must pin the exact packed profile4 qualification Node coordinate."
        : admission === "generation2-source"
          ? "Retained generation2 source requires its historical Node 24 pin or exact preserved Node 26.11.1 pin."
          : ".node-version must pin one exact Node version within >=24.18.0 <25.",
    );
  }
  await readStableConsumerFile(root, "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true);
  for (const path of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    if ((await readStableConsumerFile(root, path, 1024, false)).state !== "absent") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UNSUPPORTED_PACKAGE_MANAGER",
        `Multiple or unsupported package-manager evidence is present: ${path}.`,
      );
    }
  }
  return nodeVersion;
}
