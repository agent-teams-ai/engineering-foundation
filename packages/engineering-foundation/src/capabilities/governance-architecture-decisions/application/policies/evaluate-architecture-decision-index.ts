import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type { MarkdownDocumentObservation } from "../../../../documentation-observation/application/model/markdown-document.js";
import type {
  ArchitectureDecision,
  ArchitectureDecisionPolicy
} from "../model/architecture-decision.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES } from "../rules.js";
import { architectureDecisionDiagnostic } from "./architecture-decision-diagnostic.js";

export interface ArchitectureDecisionIndexMembership {
  readonly count: number;
  readonly decisionId: string;
  readonly sections: readonly string[];
}

interface IndexEvaluationInput {
  readonly decisions: readonly ArchitectureDecision[];
  readonly index: MarkdownDocumentObservation | undefined;
  readonly memberships: readonly ArchitectureDecisionIndexMembership[];
  readonly policy: ArchitectureDecisionPolicy;
}

export function normalizeArchitectureDecisionIndexSection(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function missingSectionDiagnostics(input: {
  readonly expectedSections: ReadonlySet<string>;
  readonly index: MarkdownDocumentObservation;
}): readonly FoundationDiagnostic[] {
  const actualSections = new Set(
    input.index.headings
      .filter((heading) => heading.depth === 2)
      .map((heading) => normalizeArchitectureDecisionIndexSection(heading.text))
  );
  return [...input.expectedSections]
    .filter((expectedSection) => !actualSections.has(expectedSection))
    .map((expectedSection) =>
      architectureDecisionDiagnostic({
        evidence: [{ kind: "expected-section", value: expectedSection }],
        message: `ADR index is missing required lifecycle section ${expectedSection}.`,
        path: input.index.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.indexMembership,
        subject: input.index.repositoryPath
      })
    );
}

function membershipDiagnostic(input: {
  readonly decision: ArchitectureDecision;
  readonly expectedSection: string;
  readonly index: MarkdownDocumentObservation;
  readonly membership: ArchitectureDecisionIndexMembership | undefined;
}): FoundationDiagnostic | undefined {
  const correct =
    input.membership !== undefined &&
    input.membership.count === 1 &&
    input.membership.sections.length === 1 &&
    input.membership.sections[0] === input.expectedSection;
  return correct
    ? undefined
    : architectureDecisionDiagnostic({
        evidence: [
          { kind: "expected-section", value: input.expectedSection },
          {
            kind: "actual-sections",
            value: input.membership?.sections.join(", ") ?? "<none>"
          }
        ],
        message: `ADR ${input.decision.id} must be listed exactly once under ${input.expectedSection} in the ADR index.`,
        path: input.decision.document.repositoryPath,
        relatedPath: input.index.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.indexMembership,
        subject: input.decision.id
      });
}

export function evaluateArchitectureDecisionIndex(
  input: IndexEvaluationInput
): readonly FoundationDiagnostic[] {
  if (input.index === undefined) {
    return [
      architectureDecisionDiagnostic({
        message: "Configured ADR index is missing from governed Markdown roots.",
        path: input.policy.index.path,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.indexMissing,
        subject: input.policy.index.path
      })
    ];
  }

  const memberships = new Map(
    input.memberships.map((membership) => [membership.decisionId, membership])
  );
  const expectedSections = new Set(
    Object.values(input.policy.index.sections).map(
      normalizeArchitectureDecisionIndexSection
    )
  );
  const diagnostics = [
    ...missingSectionDiagnostics({ expectedSections, index: input.index })
  ];
  for (const decision of input.decisions) {
    const membership = membershipDiagnostic({
      decision,
      expectedSection: normalizeArchitectureDecisionIndexSection(
        input.policy.index.sections[decision.status]
      ),
      index: input.index,
      membership: memberships.get(decision.id)
    });
    if (membership !== undefined) {
      diagnostics.push(membership);
    }
  }
  return diagnostics;
}
