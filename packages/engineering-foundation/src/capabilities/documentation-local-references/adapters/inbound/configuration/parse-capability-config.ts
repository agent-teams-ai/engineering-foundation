import type { DocumentationLocalReferencesPolicy } from "../../../application/model/documentation-local-references.js";
import { configurationInputError as inputError, assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";
import { CAPABILITY_CONFIG_SCHEMA_VERSION } from "../../../contract/config.js";


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

export function parseCapabilityConfig(input: unknown): DocumentationLocalReferencesPolicy {
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
    assertConfigRepositoryRelativePath(markdownRoot);
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
