import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertRepositoryRelativePath, loadStrictYamlFile } from "../../../strict-yaml.js";
import type { DocumentationLocalReferencesPolicy } from "../application/model/documentation-local-references.js";

export const CAPABILITY_ID = "documentation.local-references" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "DOCUMENTATION_LOCAL_REFERENCES_CONFIG_INVALID",
    message,
    phase: "documentation-local-references-config",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    inputError(`${field} must be an array of strings.`);
  }
  return value as readonly string[];
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      inputError(`${field} contains unsupported property: ${key}.`);
    }
  }
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<DocumentationLocalReferencesPolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "documentation-local-references-config",
    signal
  );
  await assertSchema(
    "documentation-local-references/v1",
    input,
    "documentation-local-references-config"
  );
  const root = record(input, "documentation local references config");
  onlyKeys(root, ["schemaVersion", "markdownRoots", "anchorProfile"], "config");
  if (root["schemaVersion"] !== CAPABILITY_CONFIG_SCHEMA_VERSION) {
    inputError(`schemaVersion must be ${CAPABILITY_CONFIG_SCHEMA_VERSION}.`);
  }
  const markdownRoots = strings(root["markdownRoots"], "markdownRoots");
  if (markdownRoots.length === 0) {
    inputError("markdownRoots must not be empty.");
  }
  const distinctRoots = new Set<string>();
  for (const markdownRoot of markdownRoots) {
    assertRepositoryRelativePath(markdownRoot, "documentation-local-references-config");
    if (distinctRoots.has(markdownRoot)) {
      inputError(`markdownRoots contains a duplicate path: ${markdownRoot}.`);
    }
    distinctRoots.add(markdownRoot);
  }
  const anchorProfile = string(root["anchorProfile"], "anchorProfile");
  if (anchorProfile !== "github" && anchorProfile !== "none") {
    inputError("anchorProfile must be one of: github, none.");
  }
  return Object.freeze({
    anchorProfile,
    markdownRoots: Object.freeze([...markdownRoots].toSorted())
  });
}
