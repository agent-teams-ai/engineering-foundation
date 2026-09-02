import type { FoundationDiagnostic } from "../../../../check-contract.js";
import {
  anchorsForMarkdownDocument,
  type MarkdownObservationIssue,
  type MarkdownReferenceResolution
} from "@agent-teams/document-authoring/observation";
import type {
  DocumentationLocalReferencesObservation,
  DocumentationLocalReferencesPolicy
} from "../model/documentation-local-references.js";
import {
  DOCUMENTATION_LOCAL_REFERENCE_RULES,
  type DocumentationLocalReferencesRuleMetadata
} from "../rules.js";

interface EvaluationInput {
  readonly observation: DocumentationLocalReferencesObservation;
  readonly policy: DocumentationLocalReferencesPolicy;
}

function diagnostic(input: {
  readonly column?: number;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
  readonly line?: number;
  readonly message: string;
  readonly path: string;
  readonly relatedPath?: string;
  readonly rule: DocumentationLocalReferencesRuleMetadata;
  readonly subject: string;
}): FoundationDiagnostic {
  return {
    evidence: input.evidence ?? [],
    location: {
      path: input.path,
      ...(input.line === undefined
        ? {}
        : {
            start: {
              column: input.column ?? 1,
              line: input.line
            }
          })
    },
    message: input.message,
    relatedLocations:
      input.relatedPath === undefined ? [] : [{ path: input.relatedPath }],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview,
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject
  };
}

function issueDiagnostic(issue: MarkdownObservationIssue): FoundationDiagnostic {
  const rule =
    issue.kind === "symbolic-link"
      ? DOCUMENTATION_LOCAL_REFERENCE_RULES.symbolicLink
      : DOCUMENTATION_LOCAL_REFERENCE_RULES.sourceUnavailable;
  return diagnostic({
    evidence: [{ kind: "observation-issue", value: issue.kind }],
    message: issue.message,
    path: issue.repositoryPath,
    rule,
    subject: issue.repositoryPath
  });
}

function resolutionDiagnostic(input: {
  readonly path: string;
  readonly rawTarget: string;
  readonly resolution: Exclude<MarkdownReferenceResolution, { readonly kind: "external" | "file" }>;
  readonly sourceColumn: number;
  readonly sourceLine: number;
}): FoundationDiagnostic {
  const base = {
    column: input.sourceColumn,
    evidence: [{ kind: "raw-target", value: input.rawTarget }],
    line: input.sourceLine,
    path: input.path,
    subject: `${input.path}:${input.sourceLine}`
  };
  if (input.resolution.kind === "missing") {
    const rule =
      input.resolution.reason === "directory-readme-missing"
        ? DOCUMENTATION_LOCAL_REFERENCE_RULES.directoryReadmeMissing
        : DOCUMENTATION_LOCAL_REFERENCE_RULES.brokenLink;
    return diagnostic({
      ...base,
      evidence: [
        ...base.evidence,
        { kind: "resolved-path", value: input.resolution.repositoryPath }
      ],
      message:
        input.resolution.reason === "directory-readme-missing"
          ? `Directory link ${input.rawTarget} has no README.md target.`
          : `Local target does not exist: ${input.rawTarget}.`,
      relatedPath: input.resolution.repositoryPath,
      rule
    });
  }
  if (input.resolution.reason === "repository-escape") {
    return diagnostic({
      ...base,
      message: `Local target escapes the repository: ${input.rawTarget}.`,
      rule: DOCUMENTATION_LOCAL_REFERENCE_RULES.repositoryEscape
    });
  }
  if (input.resolution.reason === "symbolic-link") {
    return diagnostic({
      ...base,
      message: `Local target traverses a symbolic link: ${input.rawTarget}.`,
      rule: DOCUMENTATION_LOCAL_REFERENCE_RULES.symbolicLink
    });
  }
  return diagnostic({
    ...base,
    message: `Local target is malformed or absolute: ${input.rawTarget}.`,
    rule: DOCUMENTATION_LOCAL_REFERENCE_RULES.invalidReference
  });
}

export function evaluateDocumentationLocalReferences(
  input: EvaluationInput
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = input.observation.repository.issues.map(issueDiagnostic);

  for (const observedReference of input.observation.resolvedReferences) {
    const { reference, resolution, sourcePath } = observedReference;
    if (resolution.kind === "external") {
      continue;
    }
    if (resolution.kind !== "file") {
      diagnostics.push(
        resolutionDiagnostic({
          path: sourcePath,
          rawTarget: reference.rawTarget,
          resolution,
          sourceColumn: reference.location.column,
          sourceLine: reference.location.line
        })
      );
      continue;
    }
    if (
      input.policy.anchorProfile === "none" ||
      resolution.fragment.length === 0 ||
      resolution.markdownDocument === undefined
    ) {
      continue;
    }
    const anchors = anchorsForMarkdownDocument(
      resolution.markdownDocument,
      input.policy.anchorProfile
    );
    if (!anchors.includes(resolution.fragment)) {
      diagnostics.push(
        diagnostic({
          column: reference.location.column,
          evidence: [
            { kind: "raw-target", value: reference.rawTarget },
            { kind: "fragment", value: resolution.fragment }
          ],
          line: reference.location.line,
          message: `Anchor #${resolution.fragment} is missing in ${resolution.repositoryPath}.`,
          path: sourcePath,
          relatedPath: resolution.repositoryPath,
          rule: DOCUMENTATION_LOCAL_REFERENCE_RULES.missingAnchor,
          subject: `${sourcePath}:${reference.location.line}`
        })
      );
    }
  }
  return diagnostics;
}
