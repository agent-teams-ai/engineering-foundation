import { FoundationError } from "../../features/validation-reporting/api.js";
import { FOUNDATION_PACKAGE_NAME } from "./model.js";

export function targetIsConsumer(): FoundationError {
  return new FoundationError("PACKAGE_INVALID", "Foundation target cannot be the consumer repository.");
}

export function invalidTargetSelfCheck(error: unknown): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    "Foundation target CLI self-check did not return a valid result.",
    { cause: error }
  );
}

export function targetSelfCheckMismatch(): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    "Foundation target CLI self-check disagrees with package metadata."
  );
}

export function invalidRecoveryManifest(path: string): FoundationError {
  return new FoundationError("PACKAGE_INVALID", `Invalid package.json at ${path}.`);
}

export function recoveryPathsOutsideConsumer(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Local recovery state contains paths outside its consumer-owned boundary."
  );
}

export function invalidRegistryBackup(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Registry backup identity, version, or location is invalid."
  );
}

export function unprovenRegistryEntry(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Registry backup is unavailable and the installed package cannot be proven to be the original registry entry."
  );
}

export function missingTargetPackage(): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    `Target does not contain ${FOUNDATION_PACKAGE_NAME}.`
  );
}

export function localLinkTargetMismatch(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Local package link does not resolve to the requested target."
  );
}

export function registryBackupAlreadyExists(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "A registry backup already exists; run detach to recover it before attaching."
  );
}

export function invalidInstalledEntry(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Installed foundation entry is neither a directory nor a symbolic link."
  );
}

export function installedEntryChanged(): FoundationError {
  return new FoundationError(
    "LOCAL_STATE_INVALID",
    "Installed foundation entry changed before attach could replace it."
  );
}

export function invalidRuntimeModuleExports(): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    "Foundation target runtime exports must be module objects."
  );
}

export function missingRuntimeExport(exportName: string): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    `Foundation target runtime export is unavailable: ${exportName}.`
  );
}

export function unreadableTargetManifest(error: unknown): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    "Foundation target package.json cannot be read.",
    { cause: error }
  );
}

export function unavailableBuildOutput(outputPath: string, error: unknown): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    `Foundation target build output is unavailable: ${outputPath}.`,
    { cause: error }
  );
}

export function unresolvableRuntimeDependency(dependencyName: string, error: unknown): FoundationError {
  return new FoundationError(
    "PACKAGE_INVALID",
    `Foundation target runtime dependency cannot be resolved: ${dependencyName}.`,
    { cause: error }
  );
}
