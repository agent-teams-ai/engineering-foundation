import { isAbsolute, normalize, sep } from "node:path";

import { FoundationError } from "./errors.js";

export const FOUNDATION_CONFIG_SCHEMA_VERSION = 1 as const;

export const FOUNDATION_CAPABILITIES = [
  "architecture",
  "documentation",
  "lint",
  "reliability",
  "security"
] as const;

export const FOUNDATION_PROJECT_KINDS = [
  "client",
  "runtime",
  "service",
  "tooling"
] as const;

export type FoundationCapabilityName = (typeof FOUNDATION_CAPABILITIES)[number];
export type FoundationProjectKind = (typeof FOUNDATION_PROJECT_KINDS)[number];

export interface FoundationCapabilityConfig {
  readonly enabled: boolean;
  readonly configPath?: string;
}

export interface FoundationConfig {
  readonly schemaVersion: typeof FOUNDATION_CONFIG_SCHEMA_VERSION;
  readonly projectId: string;
  readonly projectKind: FoundationProjectKind;
  readonly capabilities: Readonly<
    Partial<Record<FoundationCapabilityName, FoundationCapabilityConfig>>
  >;
}

const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectKind(value: unknown): value is FoundationProjectKind {
  return (
    typeof value === "string" &&
    FOUNDATION_PROJECT_KINDS.some((candidate) => candidate === value)
  );
}

function isCapabilityName(value: string): value is FoundationCapabilityName {
  return FOUNDATION_CAPABILITIES.some((candidate) => candidate === value);
}

function validateConfigPath(value: unknown, capability: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new FoundationError(
      "CONFIG_INVALID",
      `Capability ${capability} configPath must be a non-empty relative path.`
    );
  }

  const normalized = normalize(value);
  if (
    isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new FoundationError(
      "CONFIG_INVALID",
      `Capability ${capability} configPath cannot escape the consumer repository.`
    );
  }
  return value;
}

function parseCapabilities(value: unknown): FoundationConfig["capabilities"] {
  if (!isRecord(value)) {
    throw new FoundationError(
      "CONFIG_INVALID",
      "Foundation capabilities must be an object."
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new FoundationError(
      "CONFIG_INVALID",
      "At least one foundation capability must be declared."
    );
  }

  const parsed: Partial<
    Record<FoundationCapabilityName, FoundationCapabilityConfig>
  > = {};

  for (const [name, candidate] of entries) {
    if (!isCapabilityName(name)) {
      throw new FoundationError(
        "CONFIG_INVALID",
        `Unknown foundation capability: ${name}.`
      );
    }
    if (!isRecord(candidate) || typeof candidate.enabled !== "boolean") {
      throw new FoundationError(
        "CONFIG_INVALID",
        `Capability ${name} must declare an enabled boolean.`
      );
    }

    const allowedKeys = new Set(["configPath", "enabled"]);
    const unknownKey = Object.keys(candidate).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
      throw new FoundationError(
        "CONFIG_INVALID",
        `Capability ${name} contains unknown field: ${unknownKey}.`
      );
    }

    const configPath = validateConfigPath(candidate.configPath, name);
    parsed[name] = Object.freeze({
      enabled: candidate.enabled,
      ...(configPath === undefined ? {} : { configPath })
    });
  }

  return Object.freeze(parsed);
}

export function parseFoundationConfig(input: unknown): FoundationConfig {
  if (!isRecord(input)) {
    throw new FoundationError(
      "CONFIG_INVALID",
      "Foundation configuration must be an object."
    );
  }

  const allowedKeys = new Set([
    "capabilities",
    "projectId",
    "projectKind",
    "schemaVersion"
  ]);
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new FoundationError(
      "CONFIG_INVALID",
      `Foundation configuration contains unknown field: ${unknownKey}.`
    );
  }

  if (input.schemaVersion !== FOUNDATION_CONFIG_SCHEMA_VERSION) {
    throw new FoundationError(
      "CONFIG_INVALID",
      `Unsupported foundation schemaVersion: ${String(input.schemaVersion)}.`
    );
  }
  if (
    typeof input.projectId !== "string" ||
    !PROJECT_ID_PATTERN.test(input.projectId)
  ) {
    throw new FoundationError(
      "CONFIG_INVALID",
      "projectId must be a lowercase kebab-case identifier up to 63 characters."
    );
  }
  if (!isProjectKind(input.projectKind)) {
    throw new FoundationError(
      "CONFIG_INVALID",
      `Unknown projectKind: ${String(input.projectKind)}.`
    );
  }

  return Object.freeze({
    schemaVersion: FOUNDATION_CONFIG_SCHEMA_VERSION,
    projectId: input.projectId,
    projectKind: input.projectKind,
    capabilities: parseCapabilities(input.capabilities)
  });
}

export function defineFoundationConfig(
  input: FoundationConfig
): FoundationConfig {
  return parseFoundationConfig(input);
}
