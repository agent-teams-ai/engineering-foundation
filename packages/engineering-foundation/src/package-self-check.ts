import { createRequire } from "node:module";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compareBinaryStrings } from "./binary-string-comparator.js";
import { FoundationError } from "./errors.js";
import { FOUNDATION_SCHEMA_IDS } from "./schema-ids.js";
import { isExactVersion } from "./semantic-version.js";
import {
  FOUNDATION_LOCAL_MODE_PROTOCOL_VERSION,
  FOUNDATION_PACKAGE_NAME
} from "./local-mode/types.js";

export const FOUNDATION_METADATA_SCHEMA_VERSION = 1 as const;
const FOUNDATION_REQUIRED_PRESET_PATHS = [
  "presets/oxlint/base.json",
  "presets/oxlint/maintainability-tests.json",
  "presets/oxlint/maintainability.json",
  "presets/oxlint/node.json",
  "presets/oxlint/type-aware.json",
  "presets/typescript/base.json",
  "presets/typescript/node.json"
] as const;
export const FOUNDATION_REQUIRED_ARTIFACT_PATHS = [
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/public-api-surface.d.ts",
  "dist/document-authoring/index.d.ts",
  "dist/document-authoring/index.js",
  "dist/document-authoring/qualification/index.d.ts",
  "dist/document-authoring/qualification/index.js",
  "dist/local-mode/index.d.ts",
  "dist/local-mode/index.js",
  "dist/mutation/index.d.ts",
  "dist/mutation/index.js",
  "dist/scaffolding/index.d.ts",
  "dist/scaffolding/index.js",
  ...FOUNDATION_REQUIRED_PRESET_PATHS,
  ...FOUNDATION_SCHEMA_IDS.map((schemaId) => `schemas/${schemaId}.schema.json`),
  "assets/windows-managed-process/bootstrap.ps1",
  "assets/windows-managed-process/WindowsManagedProcess.cs"
] as const;
export const FOUNDATION_PACKAGE_FILE_ALLOWLIST = [
  "dist",
  ...FOUNDATION_REQUIRED_PRESET_PATHS,
  ...FOUNDATION_SCHEMA_IDS.map((schemaId) => `schemas/${schemaId}.schema.json`),
  "assets/windows-managed-process/bootstrap.ps1",
  "assets/windows-managed-process/WindowsManagedProcess.cs",
  "LICENSE",
  "README.md"
] as const;

export interface FoundationPackageSelfCheck {
  readonly ok: true;
  readonly metadataSchemaVersion: typeof FOUNDATION_METADATA_SCHEMA_VERSION;
  readonly packageName: "@agent-teams/engineering-foundation";
  readonly packageVersion: string;
  readonly localModeProtocolVersion: number;
  readonly compatibleLocalModeProtocolVersions: readonly number[];
  readonly exportPaths: readonly string[];
  readonly runtimeDependencies: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringRecord(
  value: unknown,
  field: string
): Record<string, string> {
  if (!isRecord(value)) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      `Foundation target ${field} must be an object.`
    );
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([name, specifier]) =>
        name.length === 0 ||
        typeof specifier !== "string" ||
        specifier.length === 0
    )
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      `Foundation target ${field} must contain non-empty string specifiers.`
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function assertExactStringArray(
  value: unknown,
  field: string,
  expected: readonly string[]
): void {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      `Foundation target ${field} must match the exact release allowlist.`
    );
  }
}

function validateExport(
  exportsField: Record<string, unknown>,
  exportPath: string,
  expected: Readonly<Record<string, string>> | string
): void {
  const candidate = exportsField[exportPath];
  if (typeof expected === "string") {
    if (candidate !== expected) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target export ${exportPath} must resolve to ${expected}.`
      );
    }
    return;
  }
  if (!isRecord(candidate)) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      `Foundation target export ${exportPath} is invalid.`
    );
  }
  for (const [condition, destination] of Object.entries(expected)) {
    if (candidate[condition] !== destination) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target export ${exportPath}.${condition} must resolve to ${destination}.`
      );
    }
  }
}

function parseProtocolMetadata(manifest: Record<string, unknown>): {
  readonly metadataSchemaVersion: typeof FOUNDATION_METADATA_SCHEMA_VERSION;
  readonly localModeProtocolVersion: number;
  readonly compatibleLocalModeProtocolVersions: readonly number[];
} {
  const metadata = manifest.agentTeamsFoundation;
  if (
    !isRecord(metadata) ||
    metadata.metadataSchemaVersion !== FOUNDATION_METADATA_SCHEMA_VERSION ||
    typeof metadata.localModeProtocolVersion !== "number" ||
    !Number.isSafeInteger(metadata.localModeProtocolVersion) ||
    metadata.localModeProtocolVersion < 1 ||
    !Array.isArray(metadata.compatibleLocalModeProtocolVersions) ||
    metadata.compatibleLocalModeProtocolVersions.length === 0 ||
    metadata.compatibleLocalModeProtocolVersions.some(
      (version) =>
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1
    )
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target protocol compatibility metadata is invalid."
    );
  }
  const compatibleLocalModeProtocolVersions = [
    ...new Set(metadata.compatibleLocalModeProtocolVersions as number[])
  ].toSorted((left, right) => left - right);
  if (
    !compatibleLocalModeProtocolVersions.includes(
      FOUNDATION_LOCAL_MODE_PROTOCOL_VERSION
    )
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      `Foundation target does not support local-mode protocol ${FOUNDATION_LOCAL_MODE_PROTOCOL_VERSION}.`
    );
  }
  return {
    metadataSchemaVersion: FOUNDATION_METADATA_SCHEMA_VERSION,
    localModeProtocolVersion: metadata.localModeProtocolVersion,
    compatibleLocalModeProtocolVersions
  };
}

function importUnknown(specifier: string): Promise<unknown> {
  return import(specifier) as Promise<unknown>;
}

async function assertRequiredRuntimeExports(packageRoot: string): Promise<void> {
  const [rootExports, documentAuthoringExports, localModeExports, scaffoldingExports] =
    await Promise.all([
      importUnknown(pathToFileURL(join(packageRoot, "dist", "index.js")).href),
      importUnknown(
        pathToFileURL(join(packageRoot, "dist", "document-authoring", "index.js")).href
      ),
      importUnknown(
        pathToFileURL(join(packageRoot, "dist", "local-mode", "index.js")).href
      ),
      importUnknown(
        pathToFileURL(join(packageRoot, "dist", "scaffolding", "index.js")).href
      )
    ]);
  if (
    !isRecord(rootExports) ||
    !isRecord(documentAuthoringExports) ||
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
    ["buildDocumentationCatalog", documentAuthoringExports.buildDocumentationCatalog],
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
  packageRoot: string
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
  if (!isRecord(manifest)) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target package.json must contain an object."
    );
  }
  if (
    manifest.name !== FOUNDATION_PACKAGE_NAME ||
    typeof manifest.version !== "string" ||
    !isExactVersion(manifest.version) ||
    manifest.type !== "module"
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target package identity, version, or module type is invalid."
    );
  }
  if (
    !isRecord(manifest.bin) ||
    manifest.bin["agent-teams-foundation"] !== "./dist/cli.js"
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target CLI entry is invalid."
    );
  }
  assertExactStringArray(
    manifest.files,
    "files",
    FOUNDATION_PACKAGE_FILE_ALLOWLIST
  );

  if (!isRecord(manifest.exports)) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target exports must be an object."
    );
  }
  validateExport(manifest.exports, ".", {
    types: "./dist/index.d.ts",
    import: "./dist/index.js"
  });
  validateExport(manifest.exports, "./local-mode", {
    types: "./dist/local-mode/index.d.ts",
    import: "./dist/local-mode/index.js"
  });
  validateExport(manifest.exports, "./document-authoring", {
    types: "./dist/document-authoring/index.d.ts",
    import: "./dist/document-authoring/index.js"
  });
  validateExport(manifest.exports, "./document-authoring/qualification", {
    types: "./dist/document-authoring/qualification/index.d.ts",
    import: "./dist/document-authoring/qualification/index.js"
  });
  validateExport(manifest.exports, "./mutation", {
    types: "./dist/mutation/index.d.ts",
    import: "./dist/mutation/index.js"
  });
  validateExport(manifest.exports, "./scaffolding", {
    types: "./dist/scaffolding/index.d.ts",
    import: "./dist/scaffolding/index.js"
  });
  validateExport(manifest.exports, "./schemas/*", "./schemas/*");
  validateExport(manifest.exports, "./presets/*", "./presets/*");
  validateExport(manifest.exports, "./package.json", "./package.json");
  for (const outputPath of FOUNDATION_REQUIRED_ARTIFACT_PATHS) {
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

  const protocolMetadata = parseProtocolMetadata(manifest);
  const runtimeDependencies = assertStringRecord(
    manifest.dependencies,
    "dependencies"
  );
  const requireFromTarget = createRequire(join(packageRoot, "package.json"));
  for (const dependencyName of Object.keys(runtimeDependencies)) {
    try {
      requireFromTarget.resolve(dependencyName);
    } catch (error) {
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target runtime dependency cannot be resolved: ${dependencyName}.`,
        { cause: error }
      );
    }
  }

  return {
    ok: true,
    ...protocolMetadata,
    packageName: FOUNDATION_PACKAGE_NAME,
    packageVersion: manifest.version,
    exportPaths: Object.keys(manifest.exports).toSorted(),
    runtimeDependencies: Object.fromEntries(
      Object.entries(runtimeDependencies).toSorted(([left], [right]) =>
        compareBinaryStrings(left, right)
      )
    )
  };
}

export function parseFoundationPackageSelfCheck(
  value: unknown
): FoundationPackageSelfCheck {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.metadataSchemaVersion !== FOUNDATION_METADATA_SCHEMA_VERSION ||
    value.packageName !== FOUNDATION_PACKAGE_NAME ||
    typeof value.packageVersion !== "string" ||
    !isExactVersion(value.packageVersion) ||
    typeof value.localModeProtocolVersion !== "number" ||
    !Array.isArray(value.compatibleLocalModeProtocolVersions) ||
    value.compatibleLocalModeProtocolVersions.some(
      (version) => typeof version !== "number"
    ) ||
    !Array.isArray(value.exportPaths) ||
    value.exportPaths.some((path) => typeof path !== "string") ||
    !isRecord(value.runtimeDependencies) ||
    Object.values(value.runtimeDependencies).some(
      (specifier) => typeof specifier !== "string"
    )
  ) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target self-check output is invalid."
    );
  }
  return value as unknown as FoundationPackageSelfCheck;
}
