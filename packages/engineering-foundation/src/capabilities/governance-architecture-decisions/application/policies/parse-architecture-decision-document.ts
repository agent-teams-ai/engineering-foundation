import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type { MarkdownDocumentObservation } from "../../../../documentation-observation/application/model/markdown-document.js";
import {
  ARCHITECTURE_DECISION_STATUSES,
  type ArchitectureDecision,
  type ArchitectureDecisionStatus
} from "../model/architecture-decision.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES } from "../rules.js";
import { architectureDecisionDiagnostic } from "./architecture-decision-diagnostic.js";

interface ParsedArchitectureDecisionDocument {
  readonly decision?: ArchitectureDecision;
  readonly diagnostics: readonly FoundationDiagnostic[];
}

interface ArchitectureDecisionMetadataFields {
  readonly id: string;
  readonly status: ArchitectureDecisionStatus;
  readonly supersededBy: readonly string[];
  readonly supersedes: readonly string[];
}

type FrontmatterMetadataResult =
  | {
      readonly diagnostics: readonly FoundationDiagnostic[];
      readonly kind: "invalid";
    }
  | {
      readonly kind: "valid";
      readonly metadata: Readonly<Record<string, unknown>>;
    };

const ADR_ID = /^ADR-\d{4}$/u;
const ADR_FILENAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

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

function architectureDecisionIds(value: unknown): readonly string[] | undefined {
  const entries = strings(value);
  return entries?.every((entry) => ADR_ID.test(entry)) === true
    ? entries
    : undefined;
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

function frontmatterMetadata(
  document: MarkdownDocumentObservation
): FrontmatterMetadataResult {
  const subject = document.repositoryPath;
  if (document.frontmatter.kind === "absent") {
    return {
      diagnostics: [
        architectureDecisionDiagnostic({
          message: "ADR document requires YAML frontmatter.",
          path: document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
          subject
        })
      ],
      kind: "invalid"
    };
  }
  if (document.frontmatter.kind === "invalid") {
    return {
      diagnostics: [
        architectureDecisionDiagnostic({
          evidence: [{ kind: "frontmatter-error", value: document.frontmatter.message }],
          message: "ADR frontmatter is invalid.",
          path: document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
          subject
        })
      ],
      kind: "invalid"
    };
  }
  const metadata = record(document.frontmatter.value);
  return metadata === undefined
    ? {
      diagnostics: [
        architectureDecisionDiagnostic({
          message: "ADR frontmatter must be a YAML object.",
          path: document.repositoryPath,
          rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
          subject
        })
      ],
      kind: "invalid"
    }
    : { kind: "valid", metadata };
}

function metadataFields(input: {
  readonly diagnostics: FoundationDiagnostic[];
  readonly document: MarkdownDocumentObservation;
  readonly metadata: Readonly<Record<string, unknown>>;
}): ArchitectureDecisionMetadataFields | undefined {
  const { diagnostics, document, metadata } = input;
  const subject = document.repositoryPath;
  const id = metadata["id"];
  const status = architectureDecisionStatus(metadata["status"]);
  const supersedes = architectureDecisionIds(metadata["supersedes"]);
  const supersededBy = architectureDecisionIds(metadata["superseded_by"]);
  const idIsValid = typeof id === "string" && ADR_ID.test(id);

  if (!idIsValid) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        message: "ADR frontmatter id must match ADR-NNNN.",
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
        subject
      })
    );
  }
  if (status === undefined) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        message: "ADR frontmatter status must be proposed, accepted, or superseded.",
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
        subject
      })
    );
  }
  if (supersedes === undefined || supersededBy === undefined) {
    diagnostics.push(
      architectureDecisionDiagnostic({
        message: "ADR supersedes and superseded_by metadata must be arrays of unique ADR IDs.",
        path: document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.frontmatterInvalid,
        subject
      })
    );
  }
  return idIsValid &&
    status !== undefined &&
    supersedes !== undefined &&
    supersededBy !== undefined
    ? { id, status, supersededBy, supersedes }
    : undefined;
}

function filenameDiagnostic(input: {
  readonly document: MarkdownDocumentObservation;
  readonly id: string;
}): FoundationDiagnostic | undefined {
  const fileMatch = filename(input.document.repositoryPath).match(ADR_FILENAME);
  if (fileMatch?.[1] !== undefined && input.id === `ADR-${fileMatch[1]}`) {
    return undefined;
  }
  return architectureDecisionDiagnostic({
    evidence: [{ kind: "adr-id", value: input.id }],
    message: `ADR filename must match ${input.id}: ${fileMatch?.[1] === undefined ? "NNNN-kebab-case.md" : `${fileMatch[1]}-kebab-case.md`}.`,
    path: input.document.repositoryPath,
    rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.filenameMismatch,
    subject: input.id
  });
}

function headingDiagnostic(input: {
  readonly document: MarkdownDocumentObservation;
  readonly id: string;
}): FoundationDiagnostic | undefined {
  const topLevelHeadings = input.document.headings.filter((heading) => heading.depth === 1);
  const topLevelHeading = topLevelHeadings[0];
  const expectedHeadingPrefix = `${input.id}: `;
  const headingIsValid =
    topLevelHeadings.length === 1 &&
    topLevelHeading !== undefined &&
    topLevelHeading.text.startsWith(expectedHeadingPrefix) &&
    topLevelHeading.text.slice(expectedHeadingPrefix.length).trim().length > 0;
  return headingIsValid
    ? undefined
    : architectureDecisionDiagnostic({
        evidence: [{ kind: "expected-heading-prefix", value: expectedHeadingPrefix }],
        message: `ADR requires exactly one level-one heading beginning with ${expectedHeadingPrefix}.`,
        path: input.document.repositoryPath,
        rule: ARCHITECTURE_DECISION_GOVERNANCE_RULES.headingMismatch,
        subject: input.id
      });
}

export function parseArchitectureDecisionDocument(
  document: MarkdownDocumentObservation
): ParsedArchitectureDecisionDocument {
  const metadata = frontmatterMetadata(document);
  if (metadata.kind === "invalid") {
    return { diagnostics: metadata.diagnostics };
  }

  const diagnostics: FoundationDiagnostic[] = [];
  const fields = metadataFields({ diagnostics, document, metadata: metadata.metadata });
  if (fields === undefined) {
    return { diagnostics };
  }

  const identityDiagnostics = [
    filenameDiagnostic({ document, id: fields.id }),
    headingDiagnostic({ document, id: fields.id })
  ].filter((entry): entry is FoundationDiagnostic => entry !== undefined);
  diagnostics.push(...identityDiagnostics);

  return {
    decision: {
      document,
      id: fields.id,
      metadata: metadata.metadata,
      status: fields.status,
      supersededBy: fields.supersededBy,
      supersedes: fields.supersedes
    },
    diagnostics
  };
}
