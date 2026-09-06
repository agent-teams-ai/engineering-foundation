import type { DocsDiagnostic, DocsFindDocument, DocsFindQuery } from "./model.js";
import type {
  DocumentAuthoringPortV2
} from "./model-v2.js";
import type {
  DocsContextRequestV1,
  DocsContextResultV1,
  DocsContextSelectionV1,
  DocsFindQueryV3,
  DocumentAuthoringFindEvidenceV3,
  DocumentAuthoringPortV3
} from "./model-v3.js";
import { normalizeDocumentId } from "../domain/document-semantics.js";
import { DocsProfileError } from "./profile-policy.js";
import { normalizeCommunityContextLimits, projectCommunityLlmsText } from "./llms-text.js";
import type { CommunitySearchIndex } from "./ranked-search.js";
import { rankCommunityDocuments } from "./ranked-search.js";

const BINARY = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));
const LOWER_ID = /^[a-z0-9][a-z0-9._/-]*$/u;

interface CommunityFindProjection {
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly outcome: "success" | "violation";
  readonly result: Readonly<{
    kind: "find";
    matches: number;
    documents: readonly DocsFindDocument[];
  }>;
}

interface CommunityFindProjectionV3 {
  readonly catalogSemanticDigest: `sha256:${string}`;
  readonly catalogStatus: "complete" | "partial";
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly outcome: "success" | "violation";
  readonly result: Readonly<{
    kind: "find";
    matches: number;
    documents: readonly DocsFindDocument[];
    ranking?: "fuzzy-advisory";
  }>;
  readonly selection: DocsContextSelectionV1;
}

interface CommunityContextProjection {
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly outcome: "authority-stale" | "success" | "violation";
  readonly result: DocsContextResultV1;
}

function signalOption(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? Object.freeze({}) : Object.freeze({ signal });
}

function communityText(
  value: string | undefined,
  ranking: "binary-default" | "fuzzy-advisory"
): string | undefined {
  if (value === undefined) {
    if (ranking === "fuzzy-advisory") {
      throw new DocsProfileError("Fuzzy advisory ranking requires non-empty search text of at most 1000 characters.");
    }
    return undefined;
  }
  const trimmed = value.normalize("NFC").trim();
  const canonical = ranking === "fuzzy-advisory" ? trimmed : trimmed.toLowerCase().normalize("NFC");
  if (canonical.length === 0) {
    if (ranking === "fuzzy-advisory") {
      throw new DocsProfileError("Fuzzy advisory ranking requires non-empty search text of at most 1000 characters.");
    }
    return undefined;
  }
  let characters = 0;
  for (const character of canonical) {
    characters += 1;
    if (characters > 1_000) {
      throw new DocsProfileError("Search text must contain at most 1000 characters.");
    }
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) {
      throw new DocsProfileError("Search text cannot contain control characters or invalid Unicode.");
    }
  }
  return canonical;
}

function normalizedLegacyQuery(query: DocsFindQuery): Readonly<DocsFindQuery> {
  return Object.freeze({
    ...query,
    ...(query.related === undefined ? {} : { related: normalizeDocumentId(query.related, "related") }),
    ...(query.blockedBy === undefined ? {} : { blockedBy: normalizeDocumentId(query.blockedBy, "blocked_by") })
  });
}

function lowerId(value: string, subject: string): string {
  const canonical = normalizeDocumentId(value, subject);
  if (canonical.length > 160 || !LOWER_ID.test(canonical)) {
    throw new DocsProfileError(`${subject} must be a bounded lowercase identifier.`);
  }
  return canonical;
}

function normalizedCommunityQuery(query: DocsFindQueryV3): Readonly<DocsFindQueryV3> {
  const ranking = query.ranking ?? "binary-default";
  const text = communityText(query.text, ranking);
  return Object.freeze({
    ...(text === undefined ? {} : { text }),
    ...(query.id === undefined ? {} : { id: normalizeDocumentId(query.id, "id") }),
    ...(query.type === undefined ? {} : { type: lowerId(query.type, "type") }),
    ...(query.status === undefined ? {} : { status: lowerId(query.status, "status") }),
    ...(query.owner === undefined ? {} : { owner: normalizeDocumentId(query.owner, "owner") }),
    ...(query.related === undefined ? {} : { related: normalizeDocumentId(query.related, "related") }),
    ...(query.blockedBy === undefined ? {} : { blockedBy: normalizeDocumentId(query.blockedBy, "blocked_by") }),
    ranking
  });
}

function contextSelection(query: Readonly<DocsFindQueryV3>): DocsContextSelectionV1 {
  const { ranking = "binary-default", ...criteria } = query;
  return Object.freeze({ ranking, query: Object.freeze(criteria) });
}

function foundationQuery(query: Readonly<DocsFindQueryV3>): Readonly<DocsFindQuery> {
  if (query.ranking !== "fuzzy-advisory") {return query;}
  return Object.freeze({
    ...(query.id === undefined ? {} : { id: query.id }),
    ...(query.type === undefined ? {} : { type: query.type }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.owner === undefined ? {} : { owner: query.owner }),
    ...(query.related === undefined ? {} : { related: query.related }),
    ...(query.blockedBy === undefined ? {} : { blockedBy: query.blockedBy })
  });
}

function catalogDiagnostics(diagnostics: DocumentAuthoringFindEvidenceV3["diagnostics"]): readonly DocsDiagnostic[] {
  return Object.freeze(diagnostics.map((entry) => Object.freeze({
    ruleId: entry.ruleId,
    severity: entry.severity,
    phase: "authority" as const,
    subject: entry.subject,
    message: entry.message
  })));
}

function diagnosticIdentity(diagnostic: DocsDiagnostic): string {
  return JSON.stringify([
    diagnostic.ruleId,
    diagnostic.severity,
    diagnostic.phase,
    diagnostic.subject,
    diagnostic.message
  ]);
}

function uniqueDiagnostics(...groups: readonly (readonly DocsDiagnostic[])[]): readonly DocsDiagnostic[] {
  const identities = new Set<string>();
  const merged: DocsDiagnostic[] = [];
  for (const group of groups) {
    for (const diagnostic of group) {
      const identity = diagnosticIdentity(diagnostic);
      if (!identities.has(identity)) {
        identities.add(identity);
        merged.push(diagnostic);
      }
    }
  }
  return Object.freeze(merged);
}

function contextDiagnostics(...groups: readonly (readonly DocsDiagnostic[])[]): readonly DocsDiagnostic[] {
  const unique = uniqueDiagnostics(...groups);
  if (unique.length <= 256) {return unique;}
  const merged = unique.slice(0, 255);
  let omitted = unique.length - merged.length;
  let marker: DocsDiagnostic = Object.freeze({
    ruleId: "docs.context.diagnostics-truncated",
    severity: "warning",
    phase: "authority",
    subject: "diagnostics",
    message: `Omitted ${String(omitted)} additional unique diagnostics after the deterministic 255-item context evidence limit.`
  });
  const duplicateIndex = merged.findIndex((diagnostic) => diagnosticIdentity(diagnostic) === diagnosticIdentity(marker));
  if (duplicateIndex >= 0) {
    merged.splice(duplicateIndex, 1);
    omitted = unique.length - merged.length;
    marker = Object.freeze({
      ruleId: "docs.context.diagnostics-truncated",
      severity: "warning",
      phase: "authority",
      subject: "diagnostics",
      message: `Omitted ${String(omitted)} additional unique diagnostics after the deterministic 255-item context evidence limit.`
    });
  }
  merged.push(marker);
  return Object.freeze(merged);
}

function projectDocuments(documents: readonly DocsFindDocument[], query: Readonly<DocsFindQueryV3>, advisoryText?: string, searchIndex?: CommunitySearchIndex) {
  const filtered = documents.filter((document) =>
    (query.related === undefined || document.related.includes(query.related)) &&
    (query.blockedBy === undefined || document.blockedBy.includes(query.blockedBy))
  );
  const matches = advisoryText === undefined
    ? filtered.toSorted((left, right) => BINARY(left.id, right.id) || BINARY(left.repositoryPath, right.repositoryPath))
    : rankCommunityDocuments({
        documents: filtered,
        query: advisoryText,
        ...(searchIndex === undefined ? {} : { searchIndex })
      }).map(({ document }) => document);
  const diagnostics: readonly DocsDiagnostic[] = query.ranking === "fuzzy-advisory"
    ? Object.freeze([{
        ruleId: "docs.find.fuzzy-advisory",
        severity: "info",
        phase: "query",
        subject: "query.ranking",
        message: "Fuzzy ranking is advisory; verify document authority and current status before acting."
      }])
    : Object.freeze([]);
  return Object.freeze({
    diagnostics,
    result: Object.freeze({
      kind: "find" as const,
      matches: matches.length,
      documents: Object.freeze(matches),
      ...(query.ranking === "fuzzy-advisory" ? { ranking: "fuzzy-advisory" as const } : {})
    })
  });
}

export async function projectLegacyFind(input: {
  readonly consumerRoot: string;
  readonly foundation: DocumentAuthoringPortV2;
  readonly foundationProfilePath: string;
  readonly query: DocsFindQuery;
  readonly signal?: AbortSignal;
}): Promise<CommunityFindProjection> {
  const query = normalizedLegacyQuery(input.query);
  const documents = await input.foundation.find({
    consumerRoot: input.consumerRoot,
    profilePath: input.foundationProfilePath,
    query: foundationQuery(query),
    ...signalOption(input.signal)
  });
  const projection = projectDocuments(documents, query);
  return Object.freeze({
    diagnostics: projection.diagnostics,
    outcome: "success" as const,
    result: Object.freeze({
      kind: "find" as const,
      matches: projection.result.matches,
      documents: projection.result.documents
    })
  });
}

export async function projectCommunityFind(input: {
  readonly searchIndex?: CommunitySearchIndex;
  readonly consumerRoot: string;
  readonly foundation: DocumentAuthoringPortV3;
  readonly foundationProfilePath: string;
  readonly query: DocsFindQueryV3;
  readonly signal?: AbortSignal;
}): Promise<CommunityFindProjectionV3> {
  const query = normalizedCommunityQuery(input.query);
  const advisoryText = query.ranking === "fuzzy-advisory" ? query.text : undefined;
  const evidence = await input.foundation.findWithEvidence({
    consumerRoot: input.consumerRoot,
    profilePath: input.foundationProfilePath,
    query: foundationQuery(query),
    ...signalOption(input.signal)
  });
  const complete = evidence.catalogStatus === "complete" && evidence.diagnostics.length === 0;
  const projection = projectDocuments(complete ? evidence.documents : Object.freeze([]), query, advisoryText, input.searchIndex);
  return Object.freeze({
    catalogSemanticDigest: evidence.catalogSemanticDigest,
    catalogStatus: evidence.catalogStatus,
    diagnostics: uniqueDiagnostics(catalogDiagnostics(evidence.diagnostics), projection.diagnostics),
    outcome: complete ? "success" as const : "violation" as const,
    result: projection.result,
    selection: contextSelection(query)
  });
}

export async function projectCommunityContext(input: {
  readonly searchIndex?: CommunitySearchIndex;
  readonly catalogBefore: Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>;
  readonly foundation: DocumentAuthoringPortV3;
  readonly foundationProfilePath: string;
  readonly request: DocsContextRequestV1;
}): Promise<CommunityContextProjection> {
  const limits = normalizeCommunityContextLimits(input.request.limits);
  const found = await projectCommunityFind({
    ...(input.searchIndex === undefined ? {} : { searchIndex: input.searchIndex }),
    consumerRoot: input.request.consumerRoot,
    foundation: input.foundation,
    foundationProfilePath: input.foundationProfilePath,
    query: input.request.query,
    ...signalOption(input.request.signal)
  });
  const catalogAfter = await input.foundation.buildCatalog({
    consumerRoot: input.request.consumerRoot,
    profilePath: input.foundationProfilePath,
    ...signalOption(input.request.signal)
  });
  const stale = input.catalogBefore.semanticDigest !== found.catalogSemanticDigest ||
    found.catalogSemanticDigest !== catalogAfter.semanticDigest ||
    input.catalogBefore.projectId !== catalogAfter.projectId;
  if (stale) {
    return Object.freeze({
      outcome: "authority-stale",
      result: Object.freeze({
        kind: "context",
        format: "llms.txt",
        projectId: catalogAfter.projectId,
        catalogSemanticDigest: catalogAfter.semanticDigest,
        selection: found.selection,
        limits,
        includedDocuments: 0,
        omittedDocuments: catalogAfter.documents.length,
        truncated: catalogAfter.documents.length > 0,
        content: ""
      }),
      diagnostics: Object.freeze([{
        ruleId: "docs.context.authority-stale",
        severity: "error" as const,
        phase: "authority" as const,
        subject: input.foundationProfilePath,
        message: "Documentation authority changed while agent context was being projected; retry from a fresh snapshot."
      }])
    });
  }
  const complete = input.catalogBefore.status === "complete" && catalogAfter.status === "complete" &&
    found.outcome === "success" && input.catalogBefore.diagnostics.length === 0 && catalogAfter.diagnostics.length === 0;
  if (!complete) {
    const diagnostics = contextDiagnostics(
      catalogDiagnostics(input.catalogBefore.diagnostics),
      found.diagnostics,
      catalogDiagnostics(catalogAfter.diagnostics)
    );
    return Object.freeze({
      outcome: "violation" as const,
      result: Object.freeze({
        kind: "context" as const,
        format: "llms.txt" as const,
        projectId: catalogAfter.projectId,
        catalogSemanticDigest: catalogAfter.semanticDigest,
        selection: found.selection,
        limits,
        includedDocuments: 0,
        omittedDocuments: catalogAfter.documents.length,
        truncated: catalogAfter.documents.length > 0,
        content: ""
      }),
      diagnostics: diagnostics.length > 0 ? diagnostics : Object.freeze([{
        ruleId: "docs.context.catalog-partial",
        severity: "error" as const,
        phase: "authority" as const,
        subject: input.foundationProfilePath,
        message: "Documentation catalog is partial; context projection is withheld until the authority is complete."
      }])
    });
  }
  const projection = projectCommunityLlmsText({
    catalog: {
      projectId: catalogAfter.projectId,
      title: `${catalogAfter.projectId} documentation`,
      summary: "Deterministic repository documentation context for humans and agents."
    },
    documents: found.result.documents,
    limits,
    selection: found.selection.ranking === "fuzzy-advisory"
      ? { kind: "fuzzy-advisory" }
      : { kind: "filtered" }
  });
  return Object.freeze({
    outcome: "success",
    result: Object.freeze({
      kind: "context",
      format: "llms.txt",
      projectId: catalogAfter.projectId,
      catalogSemanticDigest: catalogAfter.semanticDigest,
      selection: found.selection,
      ...projection
    }),
    diagnostics: found.diagnostics
  });
}
