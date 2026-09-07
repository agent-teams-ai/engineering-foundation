import type { DocumentMetadataObject } from "./metadata.js";

import type { DocsBlockerPolicy, NormalizedDocsProtocolProfile } from "./documentation-model.js";
import { normalizeDocumentIds } from "./document-semantics.js";
import { DocsProfileError } from "./profile-error.js";

const BINARY = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

const LEGACY_BLOCKER_POLICY: DocsBlockerPolicy = Object.freeze({
  types: Object.freeze(["open-decision"]),
  statuses: Object.freeze(["deferred", "open"]),
  subjectIncompatibleStatuses: Object.freeze(["accepted", "active"])
});

export function profileBlockerPolicy(profile: NormalizedDocsProtocolProfile): DocsBlockerPolicy {
  return profile.schemaVersion === 4 ? profile.relations.blockers : LEGACY_BLOCKER_POLICY;
}

interface CatalogDocument { readonly id: string; readonly type: string; readonly status: string; readonly metadata: DocumentMetadataObject }

export interface DocumentRelationsInput {
  readonly blockedBy: readonly string[];
  readonly documents: ReadonlyMap<string, CatalogDocument>;
  readonly documentId: string;
  readonly policy: DocsBlockerPolicy;
  readonly related: readonly string[];
  readonly subjectStatus: string;
}

export interface NormalizedDocumentRelations {
  readonly blockedBy: readonly string[];
  readonly related: readonly string[];
}

/** Pure consumer-vocabulary policy shared by preview, apply recapture, and corpus checks. */
export function validateDocumentRelations(input: DocumentRelationsInput): NormalizedDocumentRelations {
  const blockedBy = normalizeDocumentIds(input.blockedBy, `${input.documentId}.blocked_by`);
  const relatedInput = normalizeDocumentIds(input.related, `${input.documentId}.related`);
  const related = Object.freeze([...new Set([...relatedInput, ...blockedBy])].toSorted(BINARY));
  if (related.includes(input.documentId)) {
    throw new DocsProfileError("A document cannot relate to or be blocked by itself.");
  }
  if (input.policy.subjectIncompatibleStatuses.includes(input.subjectStatus) && blockedBy.length > 0) {
    throw new DocsProfileError(`Document status ${input.subjectStatus} cannot retain blockers.`);
  }
  const byId = input.documents;
  for (const id of related) {
    if (!byId.has(id)) {throw new DocsProfileError(`Referenced document ${id} does not exist in the complete catalog.`);}
  }
  for (const id of blockedBy) {
    const blocker = byId.get(id)!;
    if (!input.policy.types.includes(blocker.type) || !input.policy.statuses.includes(blocker.status)) {
      throw new DocsProfileError(
        `Blocker ${id} must have one configured blocker type (${input.policy.types.join(", ")}) and status (${input.policy.statuses.join(", ")}).`
      );
    }
  }
  return Object.freeze({ blockedBy, related });
}

export function validateCatalogDocumentRelations(input: {
  readonly document: CatalogDocument;
  readonly documents: ReadonlyMap<string, CatalogDocument>;
  readonly policy: DocsBlockerPolicy;
}): NormalizedDocumentRelations {
  const metadataStrings = (key: "blocked_by" | "related"): readonly string[] => {
    const value = input.document.metadata[key];
    if (value === undefined) {return Object.freeze([]);}
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw new DocsProfileError(`${input.document.id}.${key} must be an array of document IDs.`);
    }
    return value;
  };
  const relations = validateDocumentRelations({
    blockedBy: metadataStrings("blocked_by"),
    documents: input.documents,
    documentId: input.document.id,
    policy: input.policy,
    related: metadataStrings("related"),
    subjectStatus: input.document.status
  });
  for (const blocker of relations.blockedBy) {
    if (!metadataStrings("related").includes(blocker)) {
      throw new DocsProfileError(`Blocker ${blocker} must also appear in related.`);
    }
  }
  return relations;
}
