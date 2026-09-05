import type { DiagnosticSeverity } from "../../../features/validation-reporting/api.js";
import { createUniqueRegistry } from "../../../features/validation-reporting/api.js";

export interface DocumentationLocalReferencesRuleMetadata {
  readonly documentation: string;
  readonly id: string;
  readonly rationale: string;
  readonly remediation: string;
  readonly requiresArchitectureReview: boolean;
  readonly severity: DiagnosticSeverity;
}

function rule(
  suffix: string,
  rationale: string,
  remediation: string,
  requiresArchitectureReview = false
): DocumentationLocalReferencesRuleMetadata {
  return Object.freeze({
    documentation: "docs/architecture/executable-capabilities.md#documentationlocal-references",
    id: `documentation.local-references.${suffix}`,
    rationale,
    remediation,
    requiresArchitectureReview,
    severity: "error"
  });
}

export const DOCUMENTATION_LOCAL_REFERENCE_RULES = Object.freeze({
  brokenLink: rule(
    "broken-link",
    "A local Markdown target must resolve to a regular repository file.",
    "Correct the local target or add the referenced file."
  ),
  directoryReadmeMissing: rule(
    "directory-readme-missing",
    "Directory links are stable only when they resolve through an explicit README.md.",
    "Add README.md to the target directory or link to an existing file."
  ),
  invalidReference: rule(
    "invalid-reference",
    "Malformed local paths cannot be checked deterministically.",
    "Use a valid UTF-8, repository-relative Markdown target."
  ),
  missingAnchor: rule(
    "missing-anchor",
    "A configured anchor profile requires local fragments to target an existing heading.",
    "Correct the fragment or add the referenced heading."
  ),
  repositoryEscape: rule(
    "repository-escape",
    "Documentation links must not resolve outside the repository boundary.",
    "Use a repository-relative target or an explicit external URL.",
    true
  ),
  sourceUnavailable: rule(
    "source-unavailable",
    "Documentation evidence is incomplete when a configured Markdown source cannot be inspected.",
    "Restore a regular readable Markdown source under the configured root."
  ),
  symbolicLink: rule(
    "symbolic-link",
    "Symbolic links make repository-local documentation targets non-portable and can bypass containment checks.",
    "Replace the symbolic link with a regular repository file or directory.",
    true
  )
});

export const DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID: ReadonlyMap<
  string,
  DocumentationLocalReferencesRuleMetadata
> = createUniqueRegistry(
  "rule",
  Object.values(DOCUMENTATION_LOCAL_REFERENCE_RULES).map((metadata) => [
    metadata.id,
    metadata
  ])
);
