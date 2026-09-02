import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type {
  MarkdownDocumentObservation,
  MarkdownRepository
} from "@agent-teams/document-authoring/observation";
import type { ArchitectureDecision } from "../model/architecture-decision.js";
import {
  normalizeArchitectureDecisionIndexSection,
  type ArchitectureDecisionIndexMembership
} from "../policies/evaluate-architecture-decision-index.js";

export async function resolveArchitectureDecisionIndexMemberships(input: {
  readonly consumerRoot: string;
  readonly decisions: readonly ArchitectureDecision[];
  readonly index: MarkdownDocumentObservation | undefined;
  readonly repository: MarkdownRepository;
  readonly signal?: AbortSignal;
}): Promise<readonly ArchitectureDecisionIndexMembership[]> {
  if (input.index === undefined) {
    return Object.freeze([]);
  }
  const decisionsByPath = new Map(
    input.decisions.map((decision) => [decision.document.repositoryPath, decision])
  );
  const headings = input.index.headings
    .filter((heading) => heading.depth === 2)
    .toSorted((left, right) => left.location.offset - right.location.offset);
  const references = input.index.references
    .filter((reference) => reference.kind === "link")
    .toSorted((left, right) => left.location.offset - right.location.offset);
  const memberships = new Map<string, { count: number; sections: string[] }>();
  let headingIndex = 0;
  let section = "";

  for (const reference of references) {
    while (
      headingIndex < headings.length &&
      (headings[headingIndex]?.location.offset ?? Number.POSITIVE_INFINITY) <
        reference.location.offset
    ) {
      section = normalizeArchitectureDecisionIndexSection(
        headings[headingIndex]?.text ?? ""
      );
      headingIndex += 1;
    }
    const resolution = await input.repository.resolveReference({
      consumerRoot: input.consumerRoot,
      rawTarget: reference.rawTarget,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      source: input.index
    });
    if (resolution.kind !== "file") {
      continue;
    }
    const decision = decisionsByPath.get(resolution.repositoryPath);
    if (decision === undefined) {
      continue;
    }
    const current = memberships.get(decision.id) ?? { count: 0, sections: [] };
    current.count += 1;
    current.sections.push(section);
    memberships.set(decision.id, current);
  }

  return Object.freeze(
    [...memberships.entries()]
      .toSorted(([left], [right]) => compareBinaryStrings(left, right))
      .map(([decisionId, membership]) =>
        Object.freeze({
          count: membership.count,
          decisionId,
          sections: Object.freeze(membership.sections.toSorted())
        })
      )
  );
}
