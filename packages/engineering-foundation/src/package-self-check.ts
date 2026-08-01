import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FoundationError } from "./errors.js";
import { isExactVersion } from "./semantic-version.js";
import {
  FOUNDATION_LOCAL_MODE_PROTOCOL_VERSION,
  FOUNDATION_PACKAGE_NAME
} from "./local-mode/types.js";

export const FOUNDATION_METADATA_SCHEMA_VERSION = 1 as const;

export interface FoundationPackageSelfCheck {
  readonly ok: true;
  readonly metadataSchemaVersion: typeof FOUNDATION_METADATA_SCHEMA_VERSION;
  readonly packageName: typeof FOUNDATION_PACKAGE_NAME;
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
  validateExport(manifest.exports, "./schemas/*", "./schemas/*");
  validateExport(manifest.exports, "./presets/*", "./presets/*");
  validateExport(manifest.exports, "./package.json", "./package.json");
  for (const outputPath of [
    "dist/cli.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/local-mode/index.d.ts",
    "dist/local-mode/index.js",
    "presets/oxlint/base.json",
    "presets/oxlint/node.json",
    "presets/typescript/base.json",
    "presets/typescript/node.json",
    "schemas/foundation-config/v1.schema.json",
    "schemas/foundation-check-report/v1.schema.json",
    "schemas/workspace-dependency-declarations/v1.schema.json"
  ]) {
    try {
      if (!(await stat(join(packageRoot, outputPath))).isFile()) {
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
  const [rootExports, localModeExports] = await Promise.all([
    import(pathToFileURL(join(packageRoot, "dist", "index.js")).href),
    import(
      pathToFileURL(
        join(packageRoot, "dist", "local-mode", "index.js")
      ).href
    )
  ]);
  for (const [exportName, candidate] of [
    ["FoundationError", rootExports.FoundationError],
    [
      "FoundationLocalModeService",
      localModeExports.FoundationLocalModeService
    ],
    ["inspectFoundationMode", localModeExports.inspectFoundationMode]
  ]) {
    if (typeof candidate !== "function") {
      throw new FoundationError(
        "PACKAGE_INVALID",
        `Foundation target runtime export is unavailable: ${exportName}.`
      );
    }
  }

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
        left.localeCompare(right)
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
