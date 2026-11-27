import type {
  DocumentationLocalReferencesObservation,
  DocumentationLocalReferencesPolicy,
  HistoricalMarkdownArtifact,
  HistoricalMarkdownReference,
} from "../model/documentation-local-references.js";

interface HistoricalArtifactIssue {
  readonly artifact: HistoricalMarkdownArtifact;
  readonly actualSha256?: string;
  readonly reason: "source-unobserved" | "source-digest-mismatch" | "reference-set-mismatch";
}

function occurrenceKey(reference: HistoricalMarkdownReference): string {
  return JSON.stringify([reference.kind, reference.line, reference.column, reference.rawTarget]);
}

export function admitHistoricalArtifacts(
  policy: DocumentationLocalReferencesPolicy,
  observation: DocumentationLocalReferencesObservation,
): {
  readonly admitted: ReadonlyMap<string, HistoricalMarkdownArtifact>;
  readonly issues: readonly HistoricalArtifactIssue[];
} {
  if (policy.historicalArtifacts === undefined) {
    return { admitted: new Map(), issues: [] };
  }
  const absoluteReferences = new Map<string, HistoricalMarkdownReference[]>();
  for (const { reference, resolution, sourcePath } of observation.resolvedReferences) {
    if (resolution.kind !== "unsafe" || resolution.reason !== "absolute-path") continue;
    const references = absoluteReferences.get(sourcePath) ?? [];
    references.push({
      kind: reference.kind,
      line: reference.location.line,
      column: reference.location.column,
      rawTarget: reference.rawTarget,
    });
    absoluteReferences.set(sourcePath, references);
  }
  const admitted = new Map<string, HistoricalMarkdownArtifact>();
  const issues: HistoricalArtifactIssue[] = [];
  for (const artifact of policy.historicalArtifacts ?? []) {
    const actualSha256 = observation.sourceDigests.get(artifact.path);
    if (actualSha256 === undefined) {
      issues.push({ artifact, reason: "source-unobserved" });
      continue;
    }
    if (actualSha256 !== artifact.sha256) {
      issues.push({ artifact, actualSha256, reason: "source-digest-mismatch" });
      continue;
    }
    const references = absoluteReferences.get(artifact.path) ?? [];
    const observedKeys = new Set(references.map(occurrenceKey));
    const declaredKeys = new Set(artifact.references.map(occurrenceKey));
    if (
      artifact.references.length === 0 ||
      declaredKeys.size !== artifact.references.length ||
      observedKeys.size !== references.length ||
      references.length !== artifact.references.length ||
      [...declaredKeys].some((key) => !observedKeys.has(key))
    ) {
      issues.push({ artifact, actualSha256, reason: "reference-set-mismatch" });
      continue;
    }
    admitted.set(artifact.path, artifact);
  }
  return { admitted, issues };
}
