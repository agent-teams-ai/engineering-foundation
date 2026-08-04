import type {
  DiagnosticEvidence,
  FoundationDiagnostic
} from "../../../../check-contract.js";
import type {
  ObservedSourceGraph,
  SourceArchitecturePolicy
} from "../model/source-workspace.js";
import { evaluateSourceDependencyCycles } from "./evaluate-source-dependency-cycles.js";
import { evaluateResolvedSourceDependency } from "./evaluate-resolved-source-dependency.js";
import {
  SOURCE_DEPENDENCY_RULES,
  type SourceDependencyRuleMetadata
} from "../rules.js";

interface EvaluationInput {
  readonly policy: SourceArchitecturePolicy;
  readonly graph: ObservedSourceGraph;
}

function diagnostic(input: {
  readonly rule: SourceDependencyRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly evidence?: readonly DiagnosticEvidence[];
  readonly relatedPath?: string;
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations:
      input.relatedPath === undefined ? [] : [{ path: input.relatedPath }],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function entrypointDeclarationDiagnostics(
  policy: SourceArchitecturePolicy,
  graph: ObservedSourceGraph
): readonly FoundationDiagnostic[] {
  const nodesByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const diagnostics: FoundationDiagnostic[] = [];
  for (const boundary of policy.boundaries) {
    for (const entrypoint of boundary.entrypoints) {
      const node = nodesByPath.get(entrypoint);
      if (node !== undefined && node.boundaryId === boundary.id) {
        continue;
      }
      diagnostics.push(
        diagnostic({
          rule: SOURCE_DEPENDENCY_RULES.invalidBoundaryEntrypoint,
          subject: `${boundary.id}:${entrypoint}`,
          message:
            node === undefined
              ? `Boundary entrypoint is not a governed classified source file: ${entrypoint}.`
              : `Boundary entrypoint belongs to ${node.boundaryId}, not ${boundary.id}: ${entrypoint}.`,
          path: entrypoint,
          evidence: [{ kind: "boundary", value: boundary.id }]
        })
      );
    }
  }
  return diagnostics;
}

export function evaluateSourceDependencies(
  input: EvaluationInput
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const boundariesById = new Map(
    input.policy.boundaries.map((boundary) => [boundary.id, boundary])
  );
  for (const path of input.graph.unclassifiedSourcePaths) {
    diagnostics.push(
      diagnostic({
        rule: SOURCE_DEPENDENCY_RULES.unclassifiedSourceFile,
        subject: path,
        message: "Governed source file does not belong to an architecture boundary.",
        path
      })
    );
  }
  for (const failure of input.graph.parseFailures) {
    diagnostics.push(
      diagnostic({
        rule: SOURCE_DEPENDENCY_RULES.sourceParseError,
        subject: failure.path,
        message: `Source parser reported ${failure.parseErrorCount} error(s).`,
        path: failure.path,
        evidence: [{ kind: "parse-error-count", value: String(failure.parseErrorCount) }]
      })
    );
  }
  for (const unresolvedReference of input.graph.unresolvedRuntimeReferences) {
    const boundary = boundariesById.get(unresolvedReference.boundaryId);
    if (boundary?.allowedRuntimeReferences.includes(unresolvedReference.kind) === true) {
      continue;
    }
    diagnostics.push(
      diagnostic({
        rule: SOURCE_DEPENDENCY_RULES.unresolvedRuntimeReference,
        subject: `${unresolvedReference.path}:${unresolvedReference.kind}:${unresolvedReference.start}`,
        message: `Non-literal ${unresolvedReference.kind} reference hides a dependency edge.`,
        path: unresolvedReference.path,
        evidence: [
          { kind: "reference-kind", value: unresolvedReference.kind },
          { kind: "offset", value: String(unresolvedReference.start) }
        ]
      })
    );
  }
  diagnostics.push(...entrypointDeclarationDiagnostics(input.policy, input.graph));
  for (const edge of input.graph.edges) {
    diagnostics.push(
      ...evaluateResolvedSourceDependency({
        edge,
        policy: input.policy,
        boundariesById
      })
    );
  }
  diagnostics.push(...evaluateSourceDependencyCycles(input.graph));
  return diagnostics;
}
