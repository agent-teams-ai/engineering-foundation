import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type {
  MarkdownDocumentObservation,
  MarkdownObservationIssue,
  MarkdownRepositoryObservation
} from "../../../../documentation-observation/application/model/markdown-document.js";
import type { MarkdownRepository } from "../../../../documentation-observation/application/ports/markdown-repository.js";
import {
  ARCHITECTURE_DECISION_STATUSES,
  immutableArchitectureDecisionPayload,
  type AcceptedArchitectureDecisionBaseline,
  type AcceptedArchitectureDecisionBaselineEntry,
  type ArchitectureDecision,
  type ArchitectureDecisionPolicy,
  type ArchitectureDecisionStatus
} from "../model/architecture-decision.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";
import type { ArchitectureDecisionBaselineReadResult } from "../ports/architecture-decision-baseline-repository.js";
import {
  ARCHITECTURE_DECISION_GOVERNANCE_RULES,
  type ArchitectureDecisionGovernanceRuleMetadata
} from "../rules.js";

interface EvaluationInput {
  readonly baseline: ArchitectureDecisionBaselineReadResult;
  readonly consumerRoot: string;
  readonly fingerprint: ArchitectureDecisionFingerprint;
  readonly observation: MarkdownRepositoryObservation;
  readonly policy: ArchitectureDecisionPolicy;
  readonly repository: MarkdownRepository;
  readonly signal?: AbortSignal;
}

interface ParsedDecision {
  readonly decision?: ArchitectureDecision;
  readonly diagnostics: readonly FoundationDiagnostic[];
}

interface IndexMembership {
  readonly count: number;
  readonly sections: readonly string[];
}

const ADR_ID = /^ADR-\d{4}$/u;
const ADR_FILENAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

function diagnostic(input: {
  readonly column?: number;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
  readonly line?: number;
  readonly message: string;
  readonly path: string;
  readonly relatedPath?: string;
  readonly rule: ArchitectureDecisionGovernanceRuleMetadata;
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
      ? ARCHITECTURE_DECISION_GOVERNANCE_RULES.symbolicLink
      : ARCHITECTURE_DECISION_GOVERNANCE_RULES.sourceUnavailable;
  return diagnostic({
    evidence: [{ kind: "observation-issue", value: issue.kind }],
    message: issue.message,
    path: issue.repositoryPath,
    rule,
    subject: issue.repositoryPath
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  const entries = value as readonly string[];
  return new Set(entries).size === entries.length ? [...entries].toSorted() : undefined;
}

function architectureDecisionStatus(value: unknown): ArchitectureDecisionStatus | undefined {
  return typeof value === "string" &&
    ARCHITECTURE_DECISION_STATUSES.includes(value as ArchitectureDecisionStatus)
    ? (value as ArchitectureDecisionStatus)
    : undefined;
}

function filename(path: string): string {
  const segments = path.split("/");
  return segments.at(-1) ?? path;
}

function parsedDecision(document: MarkdownDocumentObservation): ParsedDecision {
  const diagnostics: FoundationDiagnostic[] = [];
  const subject = document.repositoryPath;
  if (document.frontmatter.kind === "absent") {
    return {
      diagnostics: [
        diagnostic({
          message: "ADR document requires YAML frontmatter.",
          path: document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
          subject
        })
      ]
    };
  }
  if (document.frontmatter.kind === "invalid") {
    return {
      diagnostics: [
        diagnostic({
          evidence: [{ kind: "frontmatter-error", value: document.frontmatter.message }],
          message: "ADR frontmatter is invalid.",
          path: document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
          subject
        })
      ]
    };
  }
  const metadata = record(document.frontmatter.value);
  if (metadata === undefined) {
    return {
      diagnostics: [
        diagnostic({
          message: "ADR frontmatter must be a YAML object.",
          path: document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
          subject
        })
      ]
    };
  }
  const id = metadata["id"];
  const status = architectureDecisionStatus(metadata["status"]);
  const supersedes = strings(metadata["supersedes"]);
  const supersededBy = strings(metadata["superseded_by"]);
  if (typeof id !== "string" || !ADR_ID.test(id)) {
    diagnostics.push(
      diagnostic({
        message: "ADR frontmatter id must match ADR-NNNN.",
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
        subject
      })
    );
  }
  if (status === undefined) {
    diagnostics.push(
      diagnostic({
        message: "ADR frontmatter status must be proposed, accepted, or superseded.",
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
        subject
      })
    );
  }
  if (supersedes === undefined || supersededBy === undefined) {
    diagnostics.push(
      diagnostic({
        message: "ADR supersedes and superseded_by metadata must be arrays of unique ADR IDs.",
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
        subject
      })
    );
  }
  if (typeof id !== "string" || status === undefined || supersedes === undefined || supersededBy === undefined) {
    return { diagnostics };
  }

  const fileMatch = filename(document.repositoryPath).match(ADR_FILENAME);
  if (fileMatch?.[1] === undefined || id !== `ADR-${fileMatch[1]}`) {
    diagnostics.push(
      diagnostic({
        evidence: [{ kind: "adr-id", value: id }],
        message: `ADR filename must match ${id}: ${fileMatch?.[1] === undefined ? "NNNN-kebab-case.md" : `${fileMatch[1]}-kebab-case.md`}.`,
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.filenameMismatch,
        subject: id
      })
    );
  }

  const topLevelHeadings = document.headings.filter((heading) => heading.depth === 1);
  const expectedHeadingPrefix = `${id}: `;
  if (
    topLevelHeadings.length !== 1 ||
    !topLevelHeadings[0]?.text.startsWith(expectedHeadingPrefix) ||
    topLevelHeadings[0]?.text.slice(expectedHeadingPrefix.length).trim().length === 0
  ) {
    diagnostics.push(
      diagnostic({
        evidence: [{ kind: "expected-heading-prefix", value: expectedHeadingPrefix }],
        message: `ADR requires exactly one level-one heading beginning with ${expectedHeadingPrefix}.`,
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.headingMismatch,
        subject: id
      })
    );
  }

  return {
    decision: {
      document,
      id,
      metadata,
      status,
      supersededBy,
      supersedes
    },
    diagnostics
  };
}

function normalizedSection(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function pathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function decisionByPath(
  decisions: readonly ArchitectureDecision[]
): ReadonlyMap<string, ArchitectureDecision> {
  return new Map(decisions.map((decision) => [decision.document.repositoryPath, decision]));
}

async function indexMemberships(input: {
  readonly decisions: readonly ArchitectureDecision[];
  readonly index: MarkdownDocumentObservation;
  readonly repository: MarkdownRepository;
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, IndexMembership>> {
  const decisionsByPath = decisionByPath(input.decisions);
  const headings = input.index.headings
    .filter((heading) => heading.depth === 2)
    .toSorted((left, right) => left.location.offset - right.location.offset);
  const references = input.index.references
    .filter((reference) => reference.kind === "link")
    .toSorted((left, right) => left.location.offset - right.location.offset);
  const rawMemberships = new Map<string, { count: number; sections: string[] }>();
  let headingIndex = 0;
  let section = "";

  for (const reference of references) {
    while (
      headingIndex < headings.length &&
      (headings[headingIndex]?.location.offset ?? Number.POSITIVE_INFINITY) <
        reference.location.offset
    ) {
      section = normalizedSection(headings[headingIndex]?.text ?? "");
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
    const current = rawMemberships.get(decision.id) ?? { count: 0, sections: [] };
    current.count += 1;
    current.sections.push(section);
    rawMemberships.set(decision.id, current);
  }

  return new Map(
    [...rawMemberships.entries()].map(([id, membership]) => [
      id,
      {
        count: membership.count,
        sections: membership.sections.toSorted()
      }
    ])
  );
}

function lifecycleDiagnostics(
  decisions: readonly ArchitectureDecision[]
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));

  for (const decision of decisions) {
    const subject = decision.id;
    const ownPath = decision.document.repositoryPath;
    const hasSuccessor = decision.supersededBy.length > 0;
    const hasPredecessor = decision.supersedes.length > 0;
    if (
      (decision.status === "proposed" && (hasSuccessor || hasPredecessor)) ||
      (decision.status === "accepted" && hasSuccessor) ||
      (decision.status === "superseded" && !hasSuccessor)
    ) {
      diagnostics.push(
        diagnostic({
          message: `ADR ${decision.id} has lifecycle references incompatible with status ${decision.status}.`,
          path: ownPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.lifecycleInvalid,
          subject
        })
      );
    }
    for (const targetId of decision.supersedes) {
      const target = decisionsById.get(targetId);
      if (target === undefined) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "target-adr", value: targetId }],
            message: `ADR ${decision.id} supersedes unknown ADR ${targetId}.`,
            path: ownPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
            subject
          })
        );
        continue;
      }
      if (targetId === decision.id || !target.supersededBy.includes(decision.id)) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "target-adr", value: targetId }],
            message: `ADR ${decision.id} supersedes ${targetId}, but the predecessor does not declare superseded_by ${decision.id}.`,
            path: ownPath,
            relatedPath: target.document.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
            subject
          })
        );
      }
      if (
        !["accepted", "superseded"].includes(decision.status) ||
        target.status !== "superseded"
      ) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "target-adr", value: targetId }],
            message: `Supersession ${decision.id} -> ${targetId} requires an accepted successor and superseded predecessor.`,
            path: ownPath,
            relatedPath: target.document.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.lifecycleInvalid,
            subject
          })
        );
      }
    }
    for (const targetId of decision.supersededBy) {
      const target = decisionsById.get(targetId);
      if (target === undefined) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "target-adr", value: targetId }],
            message: `ADR ${decision.id} is superseded by unknown ADR ${targetId}.`,
            path: ownPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
            subject
          })
        );
        continue;
      }
      if (targetId === decision.id || !target.supersedes.includes(decision.id)) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "target-adr", value: targetId }],
            message: `ADR ${decision.id} declares superseded_by ${targetId}, but the successor does not declare supersedes ${decision.id}.`,
            path: ownPath,
            relatedPath: target.document.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesMismatch,
            subject
          })
        );
      }
      if (
        decision.status !== "superseded" ||
        !["accepted", "superseded"].includes(target.status)
      ) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "target-adr", value: targetId }],
            message: `Superseded_by ${targetId} requires a superseded predecessor and accepted successor.`,
            path: ownPath,
            relatedPath: target.document.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.lifecycleInvalid,
            subject
          })
        );
      }
    }
  }
  return diagnostics;
}

function cycleDiagnostics(decisions: readonly ArchitectureDecision[]): readonly FoundationDiagnostic[] {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const diagnostics: FoundationDiagnostic[] = [];

  function visitDecision(id: string): void {
    if (active.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const decision = byId.get(id);
      if (decision !== undefined) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "cycle", value: cycle.join(" -> ") }],
            message: `ADR supersession cycle detected: ${cycle.join(" -> ")}.`,
            path: decision.document.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.supersedesCycle,
            subject: id
          })
        );
      }
      return;
    }
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    active.add(id);
    stack.push(id);
    const decision = byId.get(id);
    for (const predecessor of decision?.supersedes ?? []) {
      if (byId.has(predecessor)) {
        visitDecision(predecessor);
      }
    }
    stack.pop();
    active.delete(id);
  }

  for (const id of [...byId.keys()].toSorted()) {
    visitDecision(id);
  }
  return diagnostics;
}

function parseBaseline(value: unknown): AcceptedArchitectureDecisionBaseline | undefined {
  const baseline = record(value);
  if (
    baseline?.["schemaVersion"] !== 1 ||
    baseline["algorithm"] !== "sha256" ||
    !Array.isArray(baseline["decisions"])
  ) {
    return undefined;
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const decisions: AcceptedArchitectureDecisionBaselineEntry[] = [];
  for (const candidate of baseline["decisions"]) {
    const entry = record(candidate);
    const id = entry?.["id"];
    const path = entry?.["path"];
    const immutableDigest = entry?.["immutableDigest"];
    if (
      typeof id !== "string" ||
      !ADR_ID.test(id) ||
      typeof path !== "string" ||
      path.length === 0 ||
      typeof immutableDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(immutableDigest) ||
      ids.has(id) ||
      paths.has(path)
    ) {
      return undefined;
    }
    ids.add(id);
    paths.add(path);
    decisions.push({ id, immutableDigest, path });
  }
  return {
    algorithm: "sha256",
    decisions: Object.freeze(decisions.toSorted((left, right) => left.id.localeCompare(right.id))),
    schemaVersion: 1
  };
}

function baselineDiagnostics(input: {
  readonly baseline: ArchitectureDecisionBaselineReadResult;
  readonly decisions: readonly ArchitectureDecision[];
  readonly fingerprint: ArchitectureDecisionFingerprint;
  readonly path: string;
}): readonly FoundationDiagnostic[] {
  if (input.baseline.kind === "missing") {
    return [
      diagnostic({
        message: "Configured accepted-decision baseline is missing.",
        path: input.path,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineUnavailable,
        subject: input.path
      })
    ];
  }
  if (input.baseline.kind === "unsafe" || input.baseline.kind === "invalid") {
    return [
      diagnostic({
        evidence: [{ kind: "baseline-error", value: input.baseline.message }],
        message: "Configured accepted-decision baseline is unavailable or invalid.",
        path: input.path,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineInvalid,
        subject: input.path
      })
    ];
  }
  const baseline = parseBaseline(input.baseline.value);
  if (baseline === undefined) {
    return [
      diagnostic({
        message: "Accepted-decision baseline does not match the required immutable baseline shape.",
        path: input.path,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineInvalid,
        subject: input.path
      })
    ];
  }

  const diagnostics: FoundationDiagnostic[] = [];
  const baselineById = new Map(baseline.decisions.map((entry) => [entry.id, entry]));
  const currentById = new Map(input.decisions.map((decision) => [decision.id, decision]));
  for (const decision of input.decisions) {
    if (decision.status === "proposed") {
      continue;
    }
    const entry = baselineById.get(decision.id);
    if (entry === undefined) {
      diagnostics.push(
        diagnostic({
          message: `Accepted ADR ${decision.id} is absent from the immutable baseline.`,
          path: decision.document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedBaselineMissing,
          subject: decision.id
        })
      );
      continue;
    }
    if (entry.path !== decision.document.repositoryPath) {
      diagnostics.push(
        diagnostic({
          evidence: [{ kind: "baseline-path", value: entry.path }],
          message: `Accepted ADR ${decision.id} moved from ${entry.path}.`,
          path: decision.document.repositoryPath,
          relatedPath: entry.path,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.baselinePathMismatch,
          subject: decision.id
        })
      );
    }
    const actualDigest = input.fingerprint.digest(immutableArchitectureDecisionPayload(decision));
    if (entry.immutableDigest !== actualDigest) {
      diagnostics.push(
        diagnostic({
          evidence: [
            { kind: "baseline-digest", value: entry.immutableDigest },
            { kind: "actual-digest", value: actualDigest }
          ],
          message: `Accepted ADR ${decision.id} differs from its immutable baseline.`,
          path: decision.document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedDecisionMutated,
          subject: decision.id
        })
      );
    }
  }
  for (const entry of baseline.decisions) {
    const current = currentById.get(entry.id);
    if (current === undefined || current.status === "proposed") {
      diagnostics.push(
        diagnostic({
          evidence: [{ kind: "baseline-id", value: entry.id }],
          message: `Accepted-decision baseline entry ${entry.id} has no accepted or superseded ADR document.`,
          path: input.path,
          relatedPath: entry.path,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.acceptedDecisionMissing,
          subject: entry.id
        })
      );
    }
  }
  return diagnostics;
}

export async function evaluateArchitectureDecisions(
  input: EvaluationInput
): Promise<readonly FoundationDiagnostic[]> {
  const diagnostics: FoundationDiagnostic[] = input.observation.issues.map(issueDiagnostic);
  const documents = input.observation.documents.filter(
    (document) => document.repositoryPath !== input.policy.index.path
  );
  const parsed = documents.map(parsedDecision);
  diagnostics.push(...parsed.flatMap((entry) => entry.diagnostics));
  const candidates = parsed.flatMap((entry) => (entry.decision === undefined ? [] : [entry.decision]));
  const decisionsById = new Map<string, ArchitectureDecision[]>();
  for (const decision of candidates) {
    const group = decisionsById.get(decision.id) ?? [];
    group.push(decision);
    decisionsById.set(decision.id, group);
  }
  const decisions: ArchitectureDecision[] = [];
  for (const [id, group] of [...decisionsById.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    if (group.length === 1) {
      const decision = group[0];
      if (decision !== undefined) {
        decisions.push(decision);
      }
      continue;
    }
    for (const decision of group) {
      diagnostics.push(
        diagnostic({
          evidence: [{ kind: "duplicate-id", value: id }],
          message: `ADR identifier ${id} is duplicated.`,
          path: decision.document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.duplicateId,
          subject: id
        })
      );
    }
  }

  const index = input.observation.documents.find(
    (document) => document.repositoryPath === input.policy.index.path
  );
  if (index === undefined) {
    diagnostics.push(
      diagnostic({
        message: "Configured ADR index is missing from governed Markdown roots.",
        path: input.policy.index.path,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.indexMissing,
        subject: input.policy.index.path
      })
    );
  } else {
    const memberships = await indexMemberships({
      consumerRoot: input.consumerRoot,
      decisions,
      index,
      repository: input.repository,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const expectedSections = new Set(
      Object.values(input.policy.index.sections).map(normalizedSection)
    );
    const actualSections = new Set(
      index.headings
        .filter((heading) => heading.depth === 2)
        .map((heading) => normalizedSection(heading.text))
    );
    for (const expectedSection of expectedSections) {
      if (!actualSections.has(expectedSection)) {
        diagnostics.push(
          diagnostic({
            evidence: [{ kind: "expected-section", value: expectedSection }],
            message: `ADR index is missing required lifecycle section ${expectedSection}.`,
            path: index.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.indexMembership,
            subject: index.repositoryPath
          })
        );
      }
    }
    for (const decision of decisions) {
      const membership = memberships.get(decision.id);
      const expectedSection = normalizedSection(input.policy.index.sections[decision.status]);
      const correct =
        membership !== undefined &&
        membership.count === 1 &&
        membership.sections.length === 1 &&
        membership.sections[0] === expectedSection;
      if (!correct) {
        diagnostics.push(
          diagnostic({
            evidence: [
              { kind: "expected-section", value: expectedSection },
              {
                kind: "actual-sections",
                value: membership?.sections.join(", ") ?? "<none>"
              }
            ],
            message: `ADR ${decision.id} must be listed exactly once under ${expectedSection} in the ADR index.`,
            path: decision.document.repositoryPath,
            relatedPath: index.repositoryPath,
            rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.indexMembership,
            subject: decision.id
          })
        );
      }
    }
  }

  diagnostics.push(...lifecycleDiagnostics(decisions));
  diagnostics.push(...cycleDiagnostics(decisions));
  diagnostics.push(
    ...baselineDiagnostics({
      baseline: input.baseline,
      decisions,
      fingerprint: input.fingerprint,
      path: input.policy.acceptedBaselinePath
    })
  );
  return diagnostics;
}

export function decisionIsInsideAdrRoots(
  policy: ArchitectureDecisionPolicy,
  path: string
): boolean {
  return policy.adrRoots.some((root) => pathInside(path, root));
}
