import type { DocumentJsonValue, DocumentReceiptContract } from "@agent-teams/document-authoring";

import type {
  CodeAnchorMatcher,
  DocsCodeAnchor,
  DocsCommandOutcome,
  DocsDiagnostic,
  ReachabilityAction
} from "../domain/model.js";
import type { DocumentAuthoringPortV2 } from "../domain/model-v2.js";
import { normalizeCodeAnchors, normalizeDocumentIds } from "../domain/document-semantics.js";
import { DocsProfileError } from "../domain/profile-policy.js";
import { catalogMatchesExpectedPostimage } from "./authority-handshake.js";

const BINARY = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));
const BLOCKER_STATUSES = new Set(["deferred", "open"]);
const MAX_DIAGNOSTICS = 256;
const MAX_CORPUS_ANCHOR_PATTERNS = 1_024;
const MAX_CORPUS_ANCHOR_OCCURRENCES = 4_096;

export function boundedDiagnostics(diagnostics: readonly DocsDiagnostic[]): readonly DocsDiagnostic[] {
  if (diagnostics.length <= MAX_DIAGNOSTICS) {return Object.freeze([...diagnostics]);}
  return Object.freeze([
    ...diagnostics.slice(0, MAX_DIAGNOSTICS - 1),
    {
      ruleId: "docs.diagnostics.overflow",
      severity: "error",
      phase: "authority",
      subject: "docs.diagnostics",
      message: `Diagnostics exceeded the deterministic ${MAX_DIAGNOSTICS}-item output budget; additional findings were omitted.`
    }
  ]);
}

export function inspectRecapturedAnchors(
  anchors: readonly DocsCodeAnchor[],
  matchedPatterns: readonly string[]
): { readonly diagnostics: readonly DocsDiagnostic[]; readonly requiredMissing: boolean } {
  const matched = new Set(matchedPatterns);
  const missing = anchors.filter(({ pattern }) => !matched.has(pattern));
  return Object.freeze({
    diagnostics: Object.freeze(missing.map(({ enforcement, pattern }) => ({
      ruleId: enforcement === "required" ? "docs.code-anchor.required-stale" : "docs.code-anchor.advisory-unmatched",
      severity: enforcement === "required" ? "error" as const : "warning" as const,
      phase: "authority" as const,
      subject: pattern,
      message: enforcement === "required"
        ? `Required code anchor ${pattern} no longer matches a current regular file.`
        : `Advisory code anchor ${pattern} does not match a current regular file.`
    }))),
    requiredMissing: missing.some(({ enforcement }) => enforcement === "required")
  });
}

export function mergeDiagnostics(...groups: readonly (readonly DocsDiagnostic[])[]): readonly DocsDiagnostic[] {
  const seen = new Set<string>();
  const merged: DocsDiagnostic[] = [];
  for (const diagnostic of groups.flat()) {
    const identity = `${diagnostic.ruleId}\0${diagnostic.severity}\0${diagnostic.phase}\0${diagnostic.subject}\0${diagnostic.message}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      merged.push(diagnostic);
    }
  }
  return Object.freeze(merged);
}

function metadataStrings(value: DocumentJsonValue | undefined, subject: string): readonly string[] {
  if (value === undefined) {return Object.freeze([]);}
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new DocsProfileError(`${subject} must be an array of document IDs.`);
  }
  return value;
}

function semanticDiagnostic(subject: string, message: string): DocsDiagnostic {
  return { ruleId: "docs.metadata.common-semantics", severity: "error", phase: "authority", subject, message };
}

type CatalogDocument = Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>["documents"][number];

function inspectDocumentSemantics(document: CatalogDocument, byId: ReadonlyMap<string, CatalogDocument>): readonly DocsCodeAnchor[] {
  const related = normalizeDocumentIds(metadataStrings(document.metadata["related"], `${document.id}.related`), `${document.id}.related`);
  const blockedBy = normalizeDocumentIds(metadataStrings(document.metadata["blocked_by"], `${document.id}.blocked_by`), `${document.id}.blocked_by`);
  if (related.includes(document.id) || blockedBy.includes(document.id)) {throw new DocsProfileError("A document cannot reference itself.");}
  for (const id of related) {
    if (!byId.has(id)) {throw new DocsProfileError(`Related document ${id} does not exist.`);}
  }
  for (const id of blockedBy) {
    if (!related.includes(id)) {throw new DocsProfileError(`Blocker ${id} must also appear in related.`);}
    const blocker = byId.get(id);
    if (blocker === undefined || blocker.type !== "open-decision" || !BLOCKER_STATUSES.has(blocker.status)) {
      throw new DocsProfileError(`Blocker ${id} must be an open-decision with open or deferred status.`);
    }
  }
  if ((document.status === "accepted" || document.status === "active") && blockedBy.length > 0) {
    throw new DocsProfileError(`Document status ${document.status} cannot retain blockers.`);
  }
  const anchorsValue = document.metadata["code_anchors"];
  return anchorsValue === undefined
    ? []
    : Array.isArray(anchorsValue)
      ? normalizeCodeAnchors(anchorsValue)
      : (() => { throw new DocsProfileError("code_anchors must be an array."); })();
}

export async function inspectCorpusSemantics(input: {
  readonly anchors: CodeAnchorMatcher;
  readonly catalog: Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>;
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}): Promise<readonly DocsDiagnostic[]> {
  const diagnostics: DocsDiagnostic[] = [];
  let diagnosticsOverflowed = false;
  const pushDiagnostic = (diagnostic: DocsDiagnostic): void => {
    if (diagnostics.length < MAX_DIAGNOSTICS - 1) {diagnostics.push(diagnostic);}
    else if (!diagnosticsOverflowed) {
      diagnosticsOverflowed = true;
      diagnostics.push({ ruleId: "docs.diagnostics.overflow", severity: "error", phase: "authority", subject: "docs.check", message: `Diagnostics exceeded the deterministic ${MAX_DIAGNOSTICS}-item output budget; additional findings were omitted.` });
    }
  };
  const byId = new Map(input.catalog.documents.map((document) => [document.id, document]));
  const anchorOwners = new Map<string, Array<{ readonly enforcement: "advisory" | "required"; readonly id: string }>>();
  let anchorOccurrences = 0;
  let anchorBudgetExceeded = false;
  for (const document of input.catalog.documents) {
    try {
      const anchors = inspectDocumentSemantics(document, byId);
      for (const { enforcement, pattern } of anchors) {
        if (anchorOccurrences >= MAX_CORPUS_ANCHOR_OCCURRENCES || (!anchorOwners.has(pattern) && anchorOwners.size >= MAX_CORPUS_ANCHOR_PATTERNS)) {anchorBudgetExceeded = true; continue;}
        anchorOccurrences += 1;
        const owners = anchorOwners.get(pattern) ?? [];
        owners.push({ enforcement, id: document.id });
        anchorOwners.set(pattern, owners);
      }
    } catch (error) {
      pushDiagnostic(semanticDiagnostic(document.repositoryPath, error instanceof Error ? error.message : "Common metadata semantics are invalid."));
    }
  }
  if (anchorBudgetExceeded) {
    pushDiagnostic({ ruleId: "docs.code-anchor.corpus-budget-exceeded", severity: "error", phase: "authority", subject: "code_anchors", message: `Code anchors exceed the global corpus budget of ${MAX_CORPUS_ANCHOR_PATTERNS} unique patterns or ${MAX_CORPUS_ANCHOR_OCCURRENCES} occurrences.` });
  }
  const patterns = [...anchorOwners.keys()].toSorted(BINARY);
  const matched = await input.anchors.matchedPatterns({ consumerRoot: input.consumerRoot, patterns, ...(input.signal === undefined ? {} : { signal: input.signal }) });
  for (const pattern of patterns) {
    if (!matched.includes(pattern)) {
      for (const { enforcement, id } of anchorOwners.get(pattern) ?? []) {
        pushDiagnostic({ ...semanticDiagnostic(id, `Code anchor ${pattern} does not match a current regular file.`), ruleId: enforcement === "required" ? "docs.code-anchor.required-unmatched" : "docs.code-anchor.advisory-unmatched", severity: enforcement === "required" ? "error" : "warning" });
      }
    }
  }
  return Object.freeze(diagnostics);
}

export async function completeDocsNewApply(input: {
  readonly anchors: CodeAnchorMatcher;
  readonly codeAnchors: readonly DocsCodeAnchor[];
  readonly consumerRoot: string;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly foundation: DocumentAuthoringPortV2;
  readonly outcome: DocsCommandOutcome;
  readonly plan: Awaited<ReturnType<DocumentAuthoringPortV2["plan"]>>;
  readonly profilePath: string;
  readonly reachability: ReachabilityAction;
  readonly receipt: DocumentReceiptContract;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly outcome: DocsCommandOutcome;
  readonly reachability?: ReachabilityAction;
  readonly writeState?: "published-recovery-required";
}> {
  if (input.receipt.outcome !== "applied" && input.receipt.outcome !== "already-applied") {
    return { diagnostics: input.diagnostics, outcome: input.outcome };
  }
  let matchedAfterPublication: readonly string[];
  try {
    matchedAfterPublication = await input.anchors.matchedPatterns({
      consumerRoot: input.consumerRoot,
      patterns: input.codeAnchors.map(({ pattern }) => pattern),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  } catch (error) {
    return {
      diagnostics: [...input.diagnostics, {
        ruleId: "docs.code-anchor.post-publication-inspection-failed",
        severity: "error",
        phase: "authority",
        subject: input.plan.destination,
        message: `Published document code-anchor authority could not be verified; manual reconciliation is required: ${error instanceof Error ? error.message : "unknown inspection failure"}`
      }],
      outcome: "recovery-required",
      writeState: "published-recovery-required"
    };
  }
  const matched = new Set(matchedAfterPublication);
  const missing = input.codeAnchors.filter(({ pattern }) => !matched.has(pattern));
  const diagnostics = [...input.diagnostics];
  for (const { enforcement, pattern } of missing) {
    const diagnostic: DocsDiagnostic = {
      ruleId: enforcement === "required" ? "docs.code-anchor.required-stale-after-publication" : "docs.code-anchor.advisory-unmatched",
      severity: enforcement === "required" ? "error" : "warning",
      phase: "authority",
      subject: pattern,
      message: enforcement === "required"
        ? `Required code anchor ${pattern} no longer matches after publication; the published document requires manual reconciliation.`
        : `Advisory code anchor ${pattern} does not match a current regular file.`
    };
    if (!diagnostics.some((entry) => entry.ruleId === diagnostic.ruleId && entry.subject === diagnostic.subject && entry.message === diagnostic.message)) {
      diagnostics.push(diagnostic);
    }
  }
  if (missing.some(({ enforcement }) => enforcement === "required")) {
    return {
      diagnostics,
      outcome: "recovery-required",
      writeState: "published-recovery-required"
    };
  }
  let catalog: Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>;
  try {
    catalog = await input.foundation.buildCatalog({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  } catch (error) {
    return {
      diagnostics: [...diagnostics, {
        ruleId: "docs.new.catalog-postimage-unavailable",
        severity: "error",
        phase: "apply",
        subject: input.plan.destination,
        message: `Published document catalog postimage could not be verified; manual reconciliation is required: ${error instanceof Error ? error.message : "unknown catalog failure"}`
      }],
      outcome: "recovery-required",
      writeState: "published-recovery-required"
    };
  }
  if (!catalogMatchesExpectedPostimage(input.plan, catalog)) {
    return {
      diagnostics: [...diagnostics, {
        ruleId: "docs.new.catalog-postimage-mismatch",
        severity: "error",
        phase: "apply",
        subject: input.plan.destination,
        message: "Published document catalog does not match the Plan expected postimage; no reachability action was issued."
      }],
      outcome: "execution-failure"
    };
  }
  return { diagnostics, outcome: "success", reachability: input.reachability };
}
