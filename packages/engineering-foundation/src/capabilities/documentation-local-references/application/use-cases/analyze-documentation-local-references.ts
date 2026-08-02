import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { MarkdownRepository } from "../../../../documentation-observation/application/ports/markdown-repository.js";
import type { DocumentationLocalReferencesPolicy } from "../model/documentation-local-references.js";
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
  return evaluateDocumentationLocalReferences({
    consumerRoot: input.consumerRoot,
    observation,
    policy: input.policy,
    repository: dependencies.repository,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
