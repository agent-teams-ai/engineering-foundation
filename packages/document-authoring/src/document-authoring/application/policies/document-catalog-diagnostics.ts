import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import type { MarkdownObservationIssue } from "../../../documentation-observation/api.js";
import type {
  DocumentIdentityProjectionEntry,
  DocumentationCatalogDiagnostic
} from "../model/document-catalog.js";

export function catalogDiagnostic(
  ruleId: string,
  subject: string,
  message: string
): DocumentationCatalogDiagnostic {
  return Object.freeze({
    message: message.slice(0, 1000),
    ruleId,
    severity: "error",
    subject
  });
}

export function catalogObservationDiagnostic(
  issue: MarkdownObservationIssue
): DocumentationCatalogDiagnostic {
  return catalogDiagnostic(
    `document.catalog.${issue.kind}`,
    issue.repositoryPath,
    issue.message
  );
}

function normalizedCollisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function catalogCollisionDiagnostics(
  paths: readonly string[]
): readonly DocumentationCatalogDiagnostic[] {
  const grouped = new Map<string, string[]>();
  for (const path of paths) {
    const key = normalizedCollisionKey(path);
    const matches = grouped.get(key) ?? [];
    matches.push(path);
    grouped.set(key, matches);
  }
  return [...grouped.values()]
    .filter((matches) => matches.length > 1)
    .map((matches) =>
      catalogDiagnostic(
        "document.catalog.normalized-path-collision",
        matches.toSorted(compareBinaryStrings).join(","),
        "Document paths collide after case-folding and NFC normalization."
      )
    );
}

export function duplicateIdentityDiagnostics(
  entries: readonly DocumentIdentityProjectionEntry[]
): readonly DocumentationCatalogDiagnostic[] {
  const pathsById = new Map<string, string[]>();
  for (const entry of entries) {
    const paths = pathsById.get(entry.id) ?? [];
    paths.push(entry.repositoryPath);
    pathsById.set(entry.id, paths);
  }
  return [...pathsById]
    .filter(([, paths]) => paths.length > 1)
    .map(([id, paths]) =>
      catalogDiagnostic(
        "document.catalog.duplicate-id",
        id,
        `Document ID occurs at multiple paths: ${paths.toSorted(compareBinaryStrings).join(", ")}.`
      )
    );
}

export function sortCatalogDiagnostics(
  diagnostics: readonly DocumentationCatalogDiagnostic[]
): readonly DocumentationCatalogDiagnostic[] {
  return diagnostics.toSorted(
    (left, right) =>
      compareBinaryStrings(left.ruleId, right.ruleId) ||
      compareBinaryStrings(left.subject, right.subject) ||
      compareBinaryStrings(left.message, right.message)
  );
}
