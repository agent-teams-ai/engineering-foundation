import type {
  DocsNewRequest,
  DocsDiagnostic,
  DocsCodeAnchor,
  DocsAdoptionInspector,
  CodeAnchorMatcher,
} from "./model.js";
import type { DocsNewResultV2, DocsProfileReaderV2 } from "./model-v2.js";
import type { DocumentAuthoringPortV3 } from "./model-v3.js";
import type { CompiledOutputReader } from "./compiled-output-reader.js";
import type { DocsOperationResult } from "./docs-execution.js";
import { execution } from "./docs-execution.js";
import { projectReachability } from "./profile-policy.js";
import { normalizeCodeAnchors } from "../domain/document-semantics.js";
import { profileBlockerPolicy } from "../domain/blocker-policy.js";
import { documentPlanApprovalFailure } from "./approve-plan.js";
import { planAuthorityStable } from "./authority-handshake.js";
import {
  completeDocsNewApply,
  inspectRecapturedAnchors,
  mergeDiagnostics,
} from "./docs-new-completion.js";
import { compiledDocument } from "./compiled-document.js";
import {
  withSignal,
  typeOrThrow,
  assertOwnerAllowed,
  inspectNewAnchors,
  receiptOutcome,
  receiptDiagnostics,
  receiptEvidence,
  documentWriteState,
  relationMetadata,
  authoringIntent,
  validateNewRelations,
  projectTransaction,
} from "./docs-authoring-policy.js";

export interface DocsAuthoringDependencies {
  readonly compiledOutput: CompiledOutputReader;
  readonly adoption: DocsAdoptionInspector;
  readonly anchors: CodeAnchorMatcher;
  readonly foundation: DocumentAuthoringPortV3;
  readonly profiles: DocsProfileReaderV2;
}
interface PlannedDocument {
  readonly request: DocsNewRequest;
  readonly apply: boolean;
  readonly profile: Awaited<ReturnType<DocsProfileReaderV2["read"]>>;
  readonly description: Awaited<ReturnType<DocumentAuthoringPortV3["describe"]>>;
  readonly catalog: Awaited<ReturnType<DocumentAuthoringPortV3["buildCatalog"]>>;
  readonly relations: ReturnType<typeof validateNewRelations>;
  readonly codeAnchors: readonly DocsCodeAnchor[];
  readonly anchorDiagnostics: readonly DocsDiagnostic[];
  readonly plan: Awaited<ReturnType<DocumentAuthoringPortV3["plan"]>>;
}

export async function newDocumentV2(
  request: DocsNewRequest,
  dependencies: DocsAuthoringDependencies,
): Promise<DocsOperationResult<DocsNewResultV2, "docs.new">> {
  // Bind approval to invocation values before any caller-owned request can change.
  const { apply, expectedPlanDigest } = request;
  const approval = { apply, ...(expectedPlanDigest === undefined ? {} : { expectedPlanDigest }) };
  const invalidApproval = documentPlanApprovalFailure(approval);
  if (invalidApproval !== undefined) {
    return execution(
      "docs.new",
      invalidApproval.outcome,
      invalidApproval.result,
      invalidApproval.diagnostics,
    );
  }
  request.signal?.throwIfAborted();
  const profile = await dependencies.profiles.read(request);
  const transaction = await dependencies.foundation.inspect(request.consumerRoot);
  if (transaction.state !== "idle") {
    return execution(
      "docs.new",
      "recovery-required",
      Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        transaction: projectTransaction(transaction),
      }),
      [
        {
          ruleId: "docs.new.transaction-active",
          severity: "error",
          phase: "recovery",
          subject: "foundation.transaction",
          message:
            transaction.state === "recoverable"
              ? "A recoverable Foundation document transaction must be completed first."
              : transaction.reason,
        },
      ],
    );
  }
  const description = await dependencies.foundation.describe({
    consumerRoot: request.consumerRoot,
    profilePath: profile.foundationProfile.path,
    profileSchemaVersion: profile.foundationProfile.schemaVersion,
    ...withSignal(request.signal),
  });
  const type = typeOrThrow(description.types, request.intent.type);
  assertOwnerAllowed(type, request.intent.owner);
  const adoptionDiagnostics = await dependencies.adoption.inspect({
    policy: profile.adoptionPolicy,
    authorityPaths: description.authorityPaths,
    consumerRoot: request.consumerRoot,
    profilePath: request.profilePath,
    skillPath: profile.agentWorkflow.skillPath,
  });
  if (adoptionDiagnostics.some(({ severity }) => severity === "error")) {
    return execution(
      "docs.new",
      "violation",
      Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        reason: "adoption-invalid" as const,
      }),
      adoptionDiagnostics,
    );
  }
  const catalog = await dependencies.foundation.buildCatalog({
    consumerRoot: request.consumerRoot,
    profilePath: profile.foundationProfile.path,
    ...withSignal(request.signal),
  });
  const relations = validateNewRelations({
    blockedBy: request.blockedBy ?? [],
    catalog,
    documentId: request.intent.id,
    initialStatus: type.initialStatus,
    policy: profileBlockerPolicy(profile),
    related: request.related ?? [],
  });
  const codeAnchors = normalizeCodeAnchors(request.codeAnchors ?? []);
  const matchedPatterns = await dependencies.anchors.matchedPatterns({
    consumerRoot: request.consumerRoot,
    patterns: codeAnchors.map(({ pattern }) => pattern),
    ...withSignal(request.signal),
  });
  const anchorDiagnostics = mergeDiagnostics(
    adoptionDiagnostics,
    inspectNewAnchors(codeAnchors, matchedPatterns),
  );
  const normalizedRequest = { ...request, blockedBy: relations.blockedBy, codeAnchors };
  const additionalMetadata = relationMetadata(normalizedRequest, "blocked_by", "code_anchors");
  const plan = await dependencies.foundation.plan({
    consumerRoot: request.consumerRoot,
    profilePath: profile.foundationProfile.path,
    intent: authoringIntent(request, relations.related, additionalMetadata),
    parentPolicy: "create-missing-real-directories",
    ...withSignal(request.signal),
  });
  const staleApproval = documentPlanApprovalFailure(approval, plan.planDigest);
  if (staleApproval !== undefined) {
    return execution(
      "docs.new",
      staleApproval.outcome,
      staleApproval.result,
      staleApproval.diagnostics,
    );
  }
  return finishPlannedDocument(
    {
      request,
      apply,
      profile,
      description,
      catalog,
      relations,
      codeAnchors,
      anchorDiagnostics,
      plan,
    },
    dependencies,
  );
}

async function finishPlannedDocument(
  context: PlannedDocument,
  dependencies: DocsAuthoringDependencies,
): Promise<DocsOperationResult<DocsNewResultV2, "docs.new">> {
  const {
    request,
    apply,
    profile,
    description,
    catalog,
    relations,
    codeAnchors,
    anchorDiagnostics,
    plan,
  } = context;
  const profileAfterPlan = await dependencies.profiles.read(request);
  const [descriptionAfterPlan, catalogAfterPlan] = await Promise.all([
    dependencies.foundation.describe({
      consumerRoot: request.consumerRoot,
      profilePath: profile.foundationProfile.path,
      profileSchemaVersion: profile.foundationProfile.schemaVersion,
      ...withSignal(request.signal),
    }),
    dependencies.foundation.buildCatalog({
      consumerRoot: request.consumerRoot,
      profilePath: profile.foundationProfile.path,
      ...withSignal(request.signal),
    }),
  ]);
  if (
    JSON.stringify(profileAfterPlan) !== JSON.stringify(profile) ||
    !planAuthorityStable(
      plan,
      { catalog, description },
      { catalog: catalogAfterPlan, description: descriptionAfterPlan },
    )
  ) {
    return execution(
      "docs.new",
      "authority-stale",
      Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        reason: "authority-stale" as const,
      }),
      [
        {
          ruleId: "docs.new.authority-stale",
          severity: "error",
          phase: "authority",
          subject: profile.foundationProfile.path,
          message:
            "Documentation authority or catalog changed across Plan compilation; retry from a fresh snapshot.",
        },
      ],
    );
  }
  const typeAfterPlan = typeOrThrow(descriptionAfterPlan.types, request.intent.type);
  validateNewRelations({
    blockedBy: relations.blockedBy,
    catalog: catalogAfterPlan,
    documentId: request.intent.id,
    initialStatus: typeAfterPlan.initialStatus,
    policy: profileBlockerPolicy(profileAfterPlan),
    related: relations.related,
  });
  const heading =
    typeAfterPlan.heading.kind === "id-colon-title"
      ? `${request.intent.id}: ${request.intent.title}`
      : request.intent.title;
  const reachability = projectReachability(typeAfterPlan, plan.destination, heading);
  const compiled = compiledDocument(plan.output, dependencies.compiledOutput.read(plan.output), {
    anchors: codeAnchors,
    blockedBy: relations.blockedBy,
    related: relations.related,
  });
  if (!apply) {
    return execution(
      "docs.new",
      "success",
      Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "preview" as const,
        documentPath: plan.destination,
        planDigest: plan.planDigest,
        compiled,
        reachability,
      }),
      anchorDiagnostics,
    );
  }
  return applyPlannedDocument(context, dependencies, compiled, reachability);
}

async function applyPlannedDocument(
  context: PlannedDocument,
  dependencies: DocsAuthoringDependencies,
  compiled: ReturnType<typeof compiledDocument>,
  reachability: ReturnType<typeof projectReachability>,
): Promise<DocsOperationResult<DocsNewResultV2, "docs.new">> {
  const { request, profile, codeAnchors, anchorDiagnostics, plan } = context;
  // This is the last cooperative authority check before Apply. A malicious
  // same-OS-user can still race the following syscall; portable Node has no
  // directory-handle-relative transaction primitive that closes that gap.
  const matchedImmediatelyBeforeApply = await dependencies.anchors.matchedPatterns({
    consumerRoot: request.consumerRoot,
    patterns: codeAnchors.map(({ pattern }) => pattern),
    ...withSignal(request.signal),
  });
  const anchorsBeforeApply = inspectRecapturedAnchors(codeAnchors, matchedImmediatelyBeforeApply);
  const diagnosticsBeforeApply = mergeDiagnostics(
    anchorDiagnostics,
    anchorsBeforeApply.diagnostics,
  );
  if (anchorsBeforeApply.requiredMissing) {
    return execution(
      "docs.new",
      "authority-stale",
      Object.freeze({
        kind: "new" as const,
        reservation: "none" as const,
        writeState: "blocked" as const,
        reason: "authority-stale" as const,
      }),
      diagnosticsBeforeApply,
    );
  }
  request.signal?.throwIfAborted();
  const receipt = await dependencies.foundation.apply({
    consumerRoot: request.consumerRoot,
    plan,
    ...withSignal(request.signal),
  });
  const receiptResult = {
    kind: "new" as const,
    reservation: "none" as const,
    writeState: documentWriteState(receipt),
    documentPath: plan.destination,
    planDigest: plan.planDigest,
    compiled,
    receiptDigest: receipt.receiptDigest,
    receiptOutcome: receipt.outcome,
    receipt: receiptEvidence(receipt),
  };
  const completion = await completeDocsNewApply({
    anchors: dependencies.anchors,
    codeAnchors,
    consumerRoot: request.consumerRoot,
    diagnostics: mergeDiagnostics(diagnosticsBeforeApply, receiptDiagnostics(receipt)),
    foundation: dependencies.foundation,
    outcome: receiptOutcome(receipt),
    plan,
    profilePath: profile.foundationProfile.path,
    reachability,
    receipt,
    ...withSignal(request.signal),
  });
  return execution(
    "docs.new",
    completion.outcome,
    Object.freeze({
      ...receiptResult,
      ...(completion.writeState === undefined ? {} : { writeState: completion.writeState }),
      ...(completion.reachability === undefined ? {} : { reachability: completion.reachability }),
    }),
    completion.diagnostics,
  );
}
