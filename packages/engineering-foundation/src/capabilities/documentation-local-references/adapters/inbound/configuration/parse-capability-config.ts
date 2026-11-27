import type {
  DocumentationLocalReferencesPolicy,
  HistoricalMarkdownArtifact,
  HistoricalMarkdownReference,
} from "../../../application/model/documentation-local-references.js";
import {
  configurationInputError as inputError,
  assertConfigRepositoryRelativePath,
} from "../../../application/configuration-input.js";

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

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    inputError(field + " must be a positive integer at most " + maximum + ".");
  }
  return value;
}

function historicalReferences(value: unknown): readonly HistoricalMarkdownReference[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    inputError("historical artifact references must contain between 1 and 1000 occurrences.");
  }
  const occurrences = new Set<string>();
  return Object.freeze(
    value.map((entry: unknown) => {
      const reference = record(entry, "historical reference");
      onlyKeys(reference, ["kind", "line", "column", "rawTarget"], "historical reference");
      const kind = reference["kind"];
      if (kind !== "link" && kind !== "image" && kind !== "definition") {
        inputError("historical reference kind must be link, image, or definition.");
      }
      const line = positiveInteger(reference["line"], "historical reference line", 50_000);
      const column = positiveInteger(reference["column"], "historical reference column", 4_194_304);
      const rawTarget = string(reference["rawTarget"], "historical reference rawTarget");
      if (rawTarget.length === 0 || rawTarget.length > 16_384) {
        inputError("historical reference rawTarget must contain between 1 and 16384 characters.");
      }
      const identity = JSON.stringify([kind, line, column]);
      if (occurrences.has(identity)) {
        inputError("historical artifact references contain a duplicate occurrence.");
      }
      occurrences.add(identity);
      return Object.freeze({ kind, line, column, rawTarget });
    }),
  );
}

function historicalArtifacts(
  value: unknown,
  markdownRoots: readonly string[],
): readonly HistoricalMarkdownArtifact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    inputError("historicalArtifacts must contain between 1 and 100 artifacts.");
  }
  const paths = new Set<string>();
  return Object.freeze(
    value.map((entry: unknown) => {
      const artifact = record(entry, "historical artifact");
      onlyKeys(artifact, ["path", "sha256", "references"], "historical artifact");
      const path = string(artifact["path"], "historical artifact path");
      assertConfigRepositoryRelativePath(path);
      if (path.length > 300 || !/\.md$/iu.test(path)) {
        inputError("historical artifact path must identify a Markdown file within 300 characters.");
      }
      if (!markdownRoots.some((root) => path.startsWith(root + "/"))) {
        inputError(
          "historical artifact path must be beneath a configured Markdown root: " + path + ".",
        );
      }
      if (paths.has(path)) {
        inputError("historicalArtifacts contains a duplicate path: " + path + ".");
      }
      paths.add(path);
      const sha256 = string(artifact["sha256"], "historical artifact sha256");
      if (!/^[a-f0-9]{64}$/u.test(sha256)) {
        inputError(
          "historical artifact sha256 must contain exactly 64 lowercase hexadecimal digits.",
        );
      }
      return Object.freeze({
        path,
        sha256,
        references: historicalReferences(artifact["references"]),
      });
    }),
  );
}

export function parseCapabilityConfig(input: unknown): DocumentationLocalReferencesPolicy {
  const root = record(input, "documentation local references config");
  const version = root["schemaVersion"];
  onlyKeys(
    root,
    version === 2
      ? ["schemaVersion", "markdownRoots", "anchorProfile", "historicalArtifacts"]
      : ["schemaVersion", "markdownRoots", "anchorProfile"],
    "config",
  );
  if (version !== 1 && version !== 2) {
    inputError("schemaVersion must be 1 or 2.");
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
    markdownRoots: Object.freeze([...markdownRoots].toSorted()),
    ...(version === 2
      ? { historicalArtifacts: historicalArtifacts(root["historicalArtifacts"], markdownRoots) }
      : {}),
  });
}
