import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { MarkdownRepository } from "@agent-teams/document-authoring/observation";
import type {
  DocumentationLocalReferencesObservation,
  DocumentationLocalReferencesPolicy,
  ResolvedMarkdownReferenceObservation
} from "../model/documentation-local-references.js";
import { evaluateDocumentationLocalReferences } from "../policies/evaluate-documentation-local-references.js";

export interface AnalyzeDocumentationLocalReferencesInput {
  readonly consumerRoot: string;
  readonly policy: DocumentationLocalReferencesPolicy;
  readonly signal?: AbortSignal;
}

export async function analyzeDocumentationLocalReferences(
  input: AnalyzeDocumentationLocalReferencesInput,
  dependencies: { readonly repository: MarkdownRepository }
): Promise<readonly FoundationDiagnostic[]> {
  assertNotCancelled(input.signal);
  const observation = await dependencies.repository.observe({
    consumerRoot: input.consumerRoot,
    roots: input.policy.markdownRoots,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const resolvedReferences: ResolvedMarkdownReferenceObservation[] = [];
  for (const document of observation.documents) {
    for (const reference of document.references) {
      assertNotCancelled(input.signal);
      const resolution = await dependencies.repository.resolveReference({
        consumerRoot: input.consumerRoot,
        rawTarget: reference.rawTarget,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        source: document
      });
      resolvedReferences.push(
        Object.freeze({
          reference,
          resolution,
          sourcePath: document.repositoryPath
        })
      );
    }
  }
  const resolvedObservation: DocumentationLocalReferencesObservation = Object.freeze({
    repository: observation,
    resolvedReferences: Object.freeze(resolvedReferences)
  });
  return evaluateDocumentationLocalReferences({
    observation: resolvedObservation,
    policy: input.policy
  });
}
