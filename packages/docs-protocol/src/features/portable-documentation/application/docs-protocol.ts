import type { DocumentJsonValue } from "../domain/metadata.js";
import type { AuthoringReceipt as DocumentReceiptContract } from "./authoring-observation.js";

import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsCommandOutcome,
  type DocsDiagnostic,
  type DocsFindQuery,
  type DocsNewRequest,
  type CodeAnchorMatcher,
  type DocsAdoptionInspector,
  type DocsCodeAnchor
} from "./model.js";
import type {
  DocsNewResultV2,
  DocsProfileReaderV2,
  DocumentAuthoringPortV2,
  DocsBlockerPolicy
} from "./model-v2.js";
import type {
  DocsContextRequestV1,
  DocsContextResultV1,
  DocsFindQueryV3,
  DocsFindResultV3,
  DocumentAuthoringPortV3
} from "./model-v3.js";
import { DocsProfileError, projectReachability } from "./profile-policy.js";
import { assertDocumentMetadata, normalizeCodeAnchors } from "../domain/document-semantics.js";
import { profileBlockerPolicy, validateDocumentRelations } from "../domain/blocker-policy.js";
import { documentPlanApprovalFailure } from "./approve-plan.js";
import { planAuthorityStable } from "./authority-handshake.js";
import { completeDocsNewApply, inspectCorpusSemantics, inspectRecapturedAnchors, mergeDiagnostics } from "./docs-new-completion.js";
import type { DocsOperationResult } from "./docs-execution.js";
import { compatibleProfileV2, execution } from "./docs-execution.js";
import type { CompiledOutputReader } from "./compiled-output-reader.js";
import type { CommunitySearchIndex } from "./ranked-search.js";
import { compiledDocument } from "./compiled-document.js";
import { projectCommunityContext, projectCommunityFind, projectLegacyFind } from "./context.js";

const GOVERNED_METADATA = new Set(["id", "type", "status", "owner", "summary", "related", "title", "slug", "destination"]);

function withSignal(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? Object.freeze({}) : Object.freeze({ signal });
}

function typeOrThrow(types: Awaited<ReturnType<DocumentAuthoringPortV2["describe"]>>["types"], type: string) {
  const match = types.find((entry) => entry.type === type);
  if (match === undefined) {throw new DocsProfileError(`Document type ${type} is not declared by the protocol profile.`);}
  return match;
}

function assertOwnerAllowed(type: ReturnType<typeof typeOrThrow>, owner: string): void {
  if (!type.allowedOwnerIds.includes(owner)) {throw new DocsProfileError(`Owner ${owner} is not allowed for ${type.type}.`);}
}

function inspectNewAnchors(anchors: readonly DocsCodeAnchor[], matchedPatterns: readonly string[]): readonly DocsDiagnostic[] {
  const required = anchors.filter(({ enforcement, pattern }) => enforcement === "required" && !matchedPatterns.includes(pattern));
  if (required.length > 0) {throw new DocsProfileError(`Required code anchor patterns must match current regular files: ${required.map(({ pattern }) => pattern).join(", ")}.`);}
  return Object.freeze(anchors
    .filter(({ enforcement, pattern }) => enforcement === "advisory" && !matchedPatterns.includes(pattern))
    .map(({ pattern }) => ({ ruleId: "docs.code-anchor.advisory-unmatched", severity: "warning" as const, phase: "authority" as const, subject: pattern, message: `Advisory code anchor ${pattern} does not match a current regular file.` })));
}

function receiptOutcome(receipt: DocumentReceiptContract): DocsCommandOutcome {
  switch (receipt.outcome) {
    case "applied":
    case "already-applied": return "success";
    case "authority-stale": return "authority-stale";
    case "cancelled": return "cancelled";
    case "recovery-required":
    case "manual-recovery-required": return "recovery-required";
    case "failed-before-publication": return "execution-failure";
    case "rejected": return "conflict";
  }
}

function receiptDiagnostics(receipt: DocumentReceiptContract): readonly DocsDiagnostic[] {
  return receipt.diagnostics.map((entry) => ({ ...entry }));
}

function receiptEvidence(receipt: DocumentReceiptContract) {
  return Object.freeze({
    outcome: receipt.outcome,
    commit: Object.freeze({
      state: receipt.commit.state,
      publication: receipt.commit.publication,
      recoverability: receipt.commit.recoverability
    }),
    ...(receipt.schemaVersion === 2
      ? { directoryMaterialization: receipt.directoryMaterialization }
      : {})
  });
}

function documentWriteState(receipt: DocumentReceiptContract) {
  if (receipt.commit.state === "committed") {
    return receipt.commit.publication === "preexisting-exact"
      ? "already-applied" as const
      : "applied" as const;
  }
  if (receipt.commit.publication === "published") {return "published-recovery-required" as const;}
  if (receipt.commit.publication === "unknown") {return "unknown" as const;}
  return "unchanged" as const;
}

function recoveryWriteState(receipt: DocumentReceiptContract) {
  if (receipt.commit.state === "committed") {return "committed" as const;}
  if (receipt.commit.publication === "published") {return "published-recovery-required" as const;}
  if (receipt.commit.publication === "unknown") {return "unknown" as const;}
  return "unchanged" as const;
}

function relationMetadata(
  request: Omit<DocsNewRequest, "codeAnchors"> & { readonly codeAnchors?: readonly DocsCodeAnchor[] },
  blockedByKey: string,
  codeAnchorsKey: string
): Readonly<Record<string, DocumentJsonValue>> | undefined {
  assertDocumentMetadata(request.additionalMetadata ?? {});
  const metadata: Record<string, DocumentJsonValue> = { ...request.additionalMetadata };
  for (const key of Object.keys(metadata)) {
    if (GOVERNED_METADATA.has(key) || key === blockedByKey || key === codeAnchorsKey) {
      throw new DocsProfileError(`Additional metadata cannot replace governed key ${key}.`);
    }
  }
  if (request.blockedBy !== undefined && request.blockedBy.length > 0) {metadata[blockedByKey] = request.blockedBy;}
  if (request.codeAnchors !== undefined && request.codeAnchors.length > 0) {
    metadata[codeAnchorsKey] = request.codeAnchors.map(({ enforcement, pattern }) => ({ enforcement, pattern }));
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata);
}

function authoringIntent(request: DocsNewRequest, related: readonly string[], additionalMetadata: Readonly<Record<string, DocumentJsonValue>> | undefined) {
  return {
    schemaVersion: 1 as const,
    ...request.intent,
    ...(related.length === 0 ? {} : { related }),
    ...(additionalMetadata === undefined ? {} : { additionalMetadata })
  };
}

function validateNewRelations(input: {
  readonly blockedBy: readonly string[];
  readonly catalog: Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>;
  readonly documentId: string;
  readonly initialStatus: string;
  readonly policy: DocsBlockerPolicy;
  readonly related: readonly string[];
}) {
  if (input.catalog.status !== "complete") {throw new DocsProfileError("A complete Foundation v2 catalog is required before authoring.");}
  return validateDocumentRelations({
    ...input,
    documents: new Map(input.catalog.documents.map((document) => [document.id, document])),
    subjectStatus: input.initialStatus
  });
}

function projectTransaction(inspection: Awaited<ReturnType<DocumentAuthoringPortV2["inspect"]>>) {
  if (inspection.state === "idle") {
    return Object.freeze({ state: "idle" as const });
  }
  if (inspection.state === "recoverable") {
    return Object.freeze({
      state: "recoverable" as const,
      transactionKind: "document" as const,
      recovery: Object.freeze({
        commandId: "docs.recover" as const,
        args: Object.freeze({
          exactFoundationBuildIdentity: inspection.recovery.exactFoundationBuildIdentity,
          exactFoundationVersion: inspection.recovery.exactFoundationVersion
        })
      })
    });
  }
  return Object.freeze({
    state: "manual-recovery-required" as const,
    ...(inspection.transactionKind === undefined ? {} : { transactionKind: inspection.transactionKind }),
    reason: inspection.reason,
    ...(inspection.recovery === undefined ? {} : { recovery: inspection.recovery })
  });
}

export class DocsProtocol {
  readonly #compiledOutput: CompiledOutputReader;
  readonly #searchIndex: CommunitySearchIndex;
  readonly #adoption: DocsAdoptionInspector;
  readonly #anchors: CodeAnchorMatcher;
  readonly #foundation: DocumentAuthoringPortV3;
  readonly #profiles: DocsProfileReaderV2;

  constructor(input: { readonly compiledOutput: CompiledOutputReader; readonly searchIndex: CommunitySearchIndex; readonly adoption: DocsAdoptionInspector; readonly anchors: CodeAnchorMatcher; readonly foundation: DocumentAuthoringPortV3; readonly profiles: DocsProfileReaderV2 }) {
    this.#compiledOutput = input.compiledOutput;
    this.#searchIndex = input.searchIndex;
    this.#adoption = input.adoption;
    this.#anchors = input.anchors;
    this.#foundation = input.foundation;
    this.#profiles = input.profiles;
  }

  async infoV2(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }) {
    const profile = await this.#profiles.read(input);
    const compatibleProfile = compatibleProfileV2(profile);
    const description = await this.#foundation.describe({ consumerRoot: input.consumerRoot, profilePath: profile.foundationProfile.path, profileSchemaVersion: profile.foundationProfile.schemaVersion, ...withSignal(input.signal) });
    const result = Object.freeze({
      kind: "info" as const,
      projectId: description.projectId,
      protocol: compatibleProfile.protocol,
      foundationProfile: compatibleProfile.foundationProfile,
      agentWorkflow: compatibleProfile.agentWorkflow,
      authority: description.authority,
      authorityPaths: description.authorityPaths,
      catalog: description.catalog,
      semanticDigest: description.semanticDigest,
      metadataSchemaPath: description.metadataSchemaPath,
      metadataSidecar: description.metadataSidecar,
      ownerIds: description.ownerIds,
      types: description.types,
      semanticValidatorIds: compatibleProfile.semanticValidatorIds
    });
    return execution("docs.info", "success", result);
  }

  async findV2(input: { readonly consumerRoot: string; readonly profilePath: string; readonly query: DocsFindQuery; readonly signal?: AbortSignal }) {
    const profile = await this.#profiles.read(input);
    const authority = profile.foundationProfile;
    await this.#foundation.describe({ consumerRoot: input.consumerRoot, profilePath: authority.path, profileSchemaVersion: authority.schemaVersion, ...withSignal(input.signal) });
    const projection = await projectLegacyFind({ consumerRoot: input.consumerRoot, foundation: this.#foundation, foundationProfilePath: authority.path, query: input.query, ...withSignal(input.signal) });
    return execution("docs.find", "success", projection.result, projection.diagnostics);
  }

  async findV3(input: { readonly consumerRoot: string; readonly profilePath: string; readonly query: DocsFindQueryV3; readonly signal?: AbortSignal }): Promise<DocsOperationResult<DocsFindResultV3, "docs.find">> {
    const profile = await this.#profiles.read(input);
    const authority = profile.foundationProfile;
    await this.#foundation.describe({ consumerRoot: input.consumerRoot, profilePath: authority.path, profileSchemaVersion: authority.schemaVersion, ...withSignal(input.signal) });
    const projection = await projectCommunityFind({ searchIndex: this.#searchIndex, consumerRoot: input.consumerRoot, foundation: this.#foundation, foundationProfilePath: authority.path, query: input.query, ...withSignal(input.signal) });
    return execution("docs.find", projection.outcome, projection.result, projection.diagnostics);
  }

  async contextV1(input: DocsContextRequestV1): Promise<DocsOperationResult<DocsContextResultV1, "docs.context">> {
    const profile = await this.#profiles.read(input);
    const authority = profile.foundationProfile;
    const catalogBefore = await this.#foundation.buildCatalog({ consumerRoot: input.consumerRoot, profilePath: authority.path, ...withSignal(input.signal) });
    const projection = await projectCommunityContext({ searchIndex: this.#searchIndex, catalogBefore, foundation: this.#foundation, foundationProfilePath: authority.path, request: input });
    return execution("docs.context", projection.outcome, projection.result, projection.diagnostics);
  }

  async newDocumentV2(request: DocsNewRequest): Promise<DocsOperationResult<DocsNewResultV2, "docs.new">> {
    const invalidApproval = documentPlanApprovalFailure(request);
    if (invalidApproval !== undefined) {return execution("docs.new", invalidApproval.outcome, invalidApproval.result, invalidApproval.diagnostics);}
    request.signal?.throwIfAborted();
    const profile = await this.#profiles.read(request);
    const transaction = await this.#foundation.inspect(request.consumerRoot);
    if (transaction.state !== "idle") {
      return execution("docs.new", "recovery-required", Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        transaction: projectTransaction(transaction)
      }), [{
        ruleId: "docs.new.transaction-active",
        severity: "error",
        phase: "recovery",
        subject: "foundation.transaction",
        message: transaction.state === "recoverable"
          ? "A recoverable Foundation document transaction must be completed first."
          : transaction.reason
      }]);
    }
    const description = await this.#foundation.describe({ consumerRoot: request.consumerRoot, profilePath: profile.foundationProfile.path, profileSchemaVersion: profile.foundationProfile.schemaVersion, ...withSignal(request.signal) });
    const type = typeOrThrow(description.types, request.intent.type);
    assertOwnerAllowed(type, request.intent.owner);
    const adoptionDiagnostics = await this.#adoption.inspect({
      policy: profile.adoptionPolicy,
      authorityPaths: description.authorityPaths,
      consumerRoot: request.consumerRoot,
      profilePath: request.profilePath,
      skillPath: profile.agentWorkflow.skillPath
    });
    if (adoptionDiagnostics.some(({ severity }) => severity === "error")) {
      return execution("docs.new", "violation", Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        reason: "adoption-invalid" as const
      }), adoptionDiagnostics);
    }
    const catalog = await this.#foundation.buildCatalog({ consumerRoot: request.consumerRoot, profilePath: profile.foundationProfile.path, ...withSignal(request.signal) });
    const relations = validateNewRelations({
      blockedBy: request.blockedBy ?? [],
      catalog,
      documentId: request.intent.id,
      initialStatus: type.initialStatus,
      policy: profileBlockerPolicy(profile),
      related: request.related ?? []
    });
    const codeAnchors = normalizeCodeAnchors(request.codeAnchors ?? []);
    const matchedPatterns = await this.#anchors.matchedPatterns({
      consumerRoot: request.consumerRoot,
      patterns: codeAnchors.map(({ pattern }) => pattern),
      ...withSignal(request.signal)
    });
    const anchorDiagnostics = mergeDiagnostics(adoptionDiagnostics, inspectNewAnchors(codeAnchors, matchedPatterns));
    const normalizedRequest = { ...request, blockedBy: relations.blockedBy, codeAnchors };
    const additionalMetadata = relationMetadata(normalizedRequest, "blocked_by", "code_anchors");
    const plan = await this.#foundation.plan({
      consumerRoot: request.consumerRoot,
      profilePath: profile.foundationProfile.path,
      intent: authoringIntent(request, relations.related, additionalMetadata),
      parentPolicy: "create-missing-real-directories",
      ...withSignal(request.signal)
    });
    const staleApproval = documentPlanApprovalFailure(request, plan.planDigest);
    if (staleApproval !== undefined) {return execution("docs.new", staleApproval.outcome, staleApproval.result, staleApproval.diagnostics);}
    const profileAfterPlan = await this.#profiles.read(request);
    const [descriptionAfterPlan, catalogAfterPlan] = await Promise.all([
      this.#foundation.describe({ consumerRoot: request.consumerRoot, profilePath: profile.foundationProfile.path, profileSchemaVersion: profile.foundationProfile.schemaVersion, ...withSignal(request.signal) }),
      this.#foundation.buildCatalog({ consumerRoot: request.consumerRoot, profilePath: profile.foundationProfile.path, ...withSignal(request.signal) })
    ]);
    if (JSON.stringify(profileAfterPlan) !== JSON.stringify(profile) || !planAuthorityStable(
      plan,
      { catalog, description },
      { catalog: catalogAfterPlan, description: descriptionAfterPlan }
    )) {
      return execution("docs.new", "authority-stale", Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        reason: "authority-stale" as const
      }), [{
        ruleId: "docs.new.authority-stale",
        severity: "error",
        phase: "authority",
        subject: profile.foundationProfile.path,
        message: "Documentation authority or catalog changed across Plan compilation; retry from a fresh snapshot."
      }]);
    }
    const typeAfterPlan = typeOrThrow(descriptionAfterPlan.types, request.intent.type);
    validateNewRelations({ blockedBy: relations.blockedBy, catalog: catalogAfterPlan, documentId: request.intent.id, initialStatus: typeAfterPlan.initialStatus, policy: profileBlockerPolicy(profileAfterPlan), related: relations.related });
    const heading = typeAfterPlan.heading.kind === "id-colon-title" ? `${request.intent.id}: ${request.intent.title}` : request.intent.title;
    const reachability = projectReachability(typeAfterPlan, plan.destination, heading);
    const compiled = compiledDocument(plan.output, this.#compiledOutput.read(plan.output), {
      anchors: codeAnchors,
      blockedBy: relations.blockedBy,
      related: relations.related
    });
    if (!request.apply) {
      return execution("docs.new", "success", Object.freeze({ kind: "new" as const, reservation: "none" as const, writeState: "preview" as const, documentPath: plan.destination, planDigest: plan.planDigest, compiled, reachability }), anchorDiagnostics);
    }
    // This is the last cooperative authority check before Apply. A malicious
    // same-OS-user can still race the following syscall; portable Node has no
    // directory-handle-relative transaction primitive that closes that gap.
    const matchedImmediatelyBeforeApply = await this.#anchors.matchedPatterns({
      consumerRoot: request.consumerRoot,
      patterns: codeAnchors.map(({ pattern }) => pattern),
      ...withSignal(request.signal)
    });
    const anchorsBeforeApply = inspectRecapturedAnchors(codeAnchors, matchedImmediatelyBeforeApply);
    const diagnosticsBeforeApply = mergeDiagnostics(anchorDiagnostics, anchorsBeforeApply.diagnostics);
    if (anchorsBeforeApply.requiredMissing) {
      return execution("docs.new", "authority-stale", Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        reason: "authority-stale" as const
      }), diagnosticsBeforeApply);
    }
    request.signal?.throwIfAborted();
    const receipt = await this.#foundation.apply({ consumerRoot: request.consumerRoot, plan, ...withSignal(request.signal) });
    const receiptResult = {
      kind: "new" as const,
      reservation: "none" as const,
      writeState: documentWriteState(receipt),
      documentPath: plan.destination,
      planDigest: plan.planDigest,
      compiled,
      receiptDigest: receipt.receiptDigest,
      receiptOutcome: receipt.outcome,
      receipt: receiptEvidence(receipt)
    };
    const completion = await completeDocsNewApply({
      anchors: this.#anchors,
      codeAnchors,
      consumerRoot: request.consumerRoot,
      diagnostics: mergeDiagnostics(diagnosticsBeforeApply, receiptDiagnostics(receipt)),
      foundation: this.#foundation, outcome: receiptOutcome(receipt),
      plan,
      profilePath: profile.foundationProfile.path,
      reachability,
      receipt,
      ...withSignal(request.signal)
    });
    return execution("docs.new", completion.outcome, Object.freeze({
      ...receiptResult,
      ...(completion.writeState === undefined ? {} : { writeState: completion.writeState }),
      ...(completion.reachability === undefined ? {} : { reachability: completion.reachability })
    }), completion.diagnostics);
  }

  async doctorV2(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }) {
    const [environment, inspection] = await Promise.all([
      this.#foundation.inspectEnvironment({ consumerRoot: input.consumerRoot, ...withSignal(input.signal) }),
      this.#foundation.inspect(input.consumerRoot)
    ]);
    let projectId: string | undefined;
    let diagnostics: readonly DocsDiagnostic[] = [];
    try {
      const profile = await this.#profiles.read(input);
      const description = await this.#foundation.describe({ consumerRoot: input.consumerRoot, profilePath: profile.foundationProfile.path, profileSchemaVersion: profile.foundationProfile.schemaVersion, ...withSignal(input.signal) });
      projectId = description.projectId;
      diagnostics = await this.#adoption.inspect({
        policy: profile.adoptionPolicy,
        authorityPaths: description.authorityPaths,
        consumerRoot: input.consumerRoot,
        profilePath: input.profilePath,
        skillPath: profile.agentWorkflow.skillPath
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {throw error;}
      diagnostics = Object.freeze([{
        ruleId: "docs.doctor.authority-unavailable",
        severity: "error",
        phase: "authority",
        subject: input.profilePath,
        message: error instanceof Error ? error.message : "Documentation authoring authority is unavailable."
      }]);
    }
    const outcome = inspection.state !== "idle"
      ? "recovery-required"
      : diagnostics.some(({ severity }) => severity === "error")
        ? "violation"
        : "success";
    return execution("docs.doctor", outcome, Object.freeze({
      kind: "doctor" as const,
      protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }),
      ...(projectId === undefined ? {} : { projectId }),
      environment,
      transaction: projectTransaction(inspection)
    }), diagnostics);
  }

  async recoverV2(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }) {
    const inspection = await this.#foundation.inspect(input.consumerRoot);
    if (inspection.state === "idle") {
      return execution("docs.recover", "success", Object.freeze({ kind: "recover" as const, transactionState: "no-pending-transaction" as const, writeState: "unchanged" as const }));
    }
    if (inspection.state !== "recoverable") {
      return execution("docs.recover", "recovery-required", Object.freeze({ kind: "recover" as const, transactionState: "manual-required" as const, writeState: "unknown" as const, transaction: projectTransaction(inspection) }));
    }
    const receipt = await this.#foundation.recover({ consumerRoot: input.consumerRoot, ...withSignal(input.signal) });
    return execution("docs.recover", receiptOutcome(receipt), Object.freeze({
      kind: "recover" as const,
      transactionState: receipt.outcome === "applied" || receipt.outcome === "already-applied" ? "recovered" as const : "recovery-required" as const,
      writeState: recoveryWriteState(receipt),
      receiptDigest: receipt.receiptDigest,
      receipt: receiptEvidence(receipt)
    }), receiptDiagnostics(receipt));
  }

  async checkV2(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }) {
    const profile = await this.#profiles.read(input);
    const compatibleProfile = compatibleProfileV2(profile);
    const description = await this.#foundation.describe({ consumerRoot: input.consumerRoot, profilePath: profile.foundationProfile.path, profileSchemaVersion: profile.foundationProfile.schemaVersion, ...withSignal(input.signal) });
    const catalog = await this.#foundation.buildCatalog({ consumerRoot: input.consumerRoot, profilePath: profile.foundationProfile.path, ...withSignal(input.signal) });
    input.signal?.throwIfAborted();
    const semanticDiagnostics = await inspectCorpusSemantics({
      anchors: this.#anchors,
      catalog,
      policy: profileBlockerPolicy(profile),
      consumerRoot: input.consumerRoot,
      ...withSignal(input.signal)
    });
    const adoptionDiagnostics = await this.#adoption.inspect({
      policy: profile.adoptionPolicy,
      authorityPaths: description.authorityPaths,
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      skillPath: profile.agentWorkflow.skillPath
    });
    const transaction = await this.#foundation.inspect(input.consumerRoot);
    const diagnostics: DocsDiagnostic[] = [
      ...catalog.diagnostics.map((entry) => ({ ...entry, phase: "authority" as const })),
      ...semanticDiagnostics,
      ...adoptionDiagnostics,
      ...(transaction.state === "idle" ? [] : [{ ruleId: "docs.adoption.recovery-state-active", severity: "error" as const, phase: "recovery" as const, subject: "foundation.transaction", message: "Active or preserved Foundation recovery state must be resolved before docs:check succeeds." }])
    ];
    const valid = catalog.status === "complete" && catalog.projectId === description.projectId && !diagnostics.some(({ severity }) => severity === "error");
    return execution("docs.check", valid ? "success" : "violation", Object.freeze({ kind: "check" as const, projectId: description.projectId, catalogStatus: catalog.status, documents: catalog.documents.length, foundationProfile: compatibleProfile.foundationProfile, metadataSidecar: description.metadataSidecar, semanticValidatorIds: compatibleProfile.semanticValidatorIds, valid }), diagnostics);
  }

}
