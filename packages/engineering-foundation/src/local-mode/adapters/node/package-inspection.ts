import { createRequire } from "node:module";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FoundationError } from "../../../features/validation-reporting/api.js";
import { packageMetadata, validatePackageManifest } from "../../application/package-metadata.js";
import type { FoundationPackageArtifactPolicy, FoundationPackageSelfCheck } from "../../application/package-metadata.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function importUnknown(specifier: string): Promise<unknown> {
  return import(specifier) as Promise<unknown>;
}

function isImportOnlyPackageResolution(error: unknown): boolean {
  return isRecord(error) && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

async function assertRequiredRuntimeExports(packageRoot: string): Promise<void> {
  const [rootExports, localModeExports, scaffoldingExports] =
    await Promise.all([
      importUnknown(pathToFileURL(join(packageRoot, "dist", "index.js")).href),
      importUnknown(
        pathToFileURL(join(packageRoot, "dist", "local-mode", "index.js")).href
      ),
      importUnknown(
        pathToFileURL(join(packageRoot, "dist", "scaffolding", "index.js")).href
      )
    ]);
  if (
    !isRecord(rootExports) ||
    !isRecord(localModeExports) ||
    !isRecord(scaffoldingExports)
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target runtime exports must be module objects."
    );
  }
  const requiredRuntimeExports: readonly (readonly [string, unknown])[] = [
    ["FoundationError", rootExports.FoundationError],
    ["FoundationLocalModeService", localModeExports.FoundationLocalModeService],
    ["planScaffoldFromFile", scaffoldingExports.planScaffoldFromFile],
    ["applyFilesystemScaffold", scaffoldingExports.applyFilesystemScaffold],
    ["inspectFoundationMode", localModeExports.inspectFoundationMode]
  ];
  for (const [exportName, candidate] of requiredRuntimeExports) {
    if (typeof candidate !== "function") {
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target runtime export is unavailable: ${exportName}.`
      );
    }
  }
}

export async function inspectFoundationPackage(
  packageRoot: string,
  artifactPolicy: FoundationPackageArtifactPolicy
): Promise<FoundationPackageSelfCheck> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8")
    ) as unknown;
  } catch (error) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target package.json cannot be read.",
      { cause: error }
    );
  }
  validatePackageManifest(manifest, artifactPolicy.packageFileAllowlist);
  for (const outputPath of artifactPolicy.requiredArtifactPaths) {
    try {
      const metadata = await lstat(join(packageRoot, outputPath));
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("not a regular file");
      }
    } catch (error) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target build output is unavailable: ${outputPath}.`,
        { cause: error }
      );
    }
  }
  await assertRequiredRuntimeExports(packageRoot);

  const { selfCheck, runtimeDependencyNames } = packageMetadata(manifest);
  const requireFromTarget = createRequire(
    join(await realpath(packageRoot), "package.json")
  );
  for (const dependencyName of runtimeDependencyNames) {
    try {
      requireFromTarget.resolve(dependencyName);
    } catch (error) {
      if (isImportOnlyPackageResolution(error)) {
        continue;
      }
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target runtime dependency cannot be resolved: ${dependencyName}.`,
        { cause: error }
      );
    }
  }

  return selfCheck;
}
