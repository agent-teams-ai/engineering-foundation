import { assertSchema } from "./schema-catalog.js";
import { installedDocumentAuthoringBuildIdentity, installedDocumentMutationArtifact } from "./installed-artifact-identity.js";
import { installedDocumentAuthoringVersion } from "./package-version.js";
import { join } from "node:path";

import {
  FOUNDATION_TRANSACTION_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../application/model/state-contract.js";
import { NodeDocumentContractValidator } from "./node-document-contract-validator.js";
import { NodeDocumentFileState } from "./node-document-file-state.js";
import { NodeDocumentJournalStore } from "./node-document-journal-store.js";
import {
  NodeDocumentPublisher,
  type NodeDocumentPublisherOperations
} from "./node-document-publisher.js";
import { NodeDocumentParentMaterializerV2 } from "./node-document-parent-materializer.js";
import { captureNodeRepositoryRootAuthority } from "./node-path-authority.js";
import { createNodeDocumentTransactionCoordinator } from "./node-document-transaction-coordinator.js";
import type { DocumentPlanContract as DocumentPlan } from "../../application/model/document-planning.js";
import type { DocumentReceiptContract as DocumentReceipt } from "../../application/model/document-receipt.js";
import {
  applyDocumentPlan,
  type ApplyDocumentPlanRequest
} from "../../application/use-cases/apply-document-plan.js";
import type {
  DocumentTransactionFaultInjector,
  DocumentTransactionFaultPoint
} from "../../application/use-cases/document-transaction-continuation.js";
import {
  recoverDocumentTransaction,
  type RecoverDocumentTransactionRequest
} from "../../application/use-cases/recover-document-transaction.js";
import type { DocumentAuthorityRecompiler } from "../../application/ports/document-authority-recompiler.js";

type NodeDocumentWritingFaultPoint =
  | DocumentTransactionFaultPoint
  | Parameters<NonNullable<NodeDocumentPublisherOperations["faultInjector"]>>[0];

type NodeDocumentWritingFaultInjector = (
  point: NodeDocumentWritingFaultPoint
) => Promise<void> | void;

export interface NodeDocumentWritingPrivateOperations {
  readonly faultInjector?: NodeDocumentWritingFaultInjector;
  readonly publisher?: Omit<NodeDocumentPublisherOperations, "faultInjector">;
}

function journalPath(consumerRoot: string): string {
  return join(consumerRoot, LOCAL_STATE_DIRECTORY, FOUNDATION_TRANSACTION_FILE);
}

async function canonicalConsumerRoot(consumerRoot: string): Promise<string> {
  return (await captureNodeRepositoryRootAuthority(consumerRoot)).canonicalRoot;
}

async function runtime(
  consumerRoot: string,
  operations: NodeDocumentWritingPrivateOperations,
  authority: DocumentAuthorityRecompiler
) {
  const faultInjector: DocumentTransactionFaultInjector | undefined =
    operations.faultInjector;
  const [version, buildIdentity, kernelArtifact] = await Promise.all([
    installedDocumentAuthoringVersion(), installedDocumentAuthoringBuildIdentity(),
    installedDocumentMutationArtifact()
  ]);
  return {
    authority,
    compiler: Object.freeze({ id: "@agent-teams/document-authoring" as const, version, buildIdentity }),
    kernelArtifact,
    schema: { assertSchema },
    fileState: new NodeDocumentFileState(),
    ...(faultInjector === undefined ? {} : { faultInjector }),
    journal: new NodeDocumentJournalStore(journalPath(consumerRoot)),
    parentMaterializer: new NodeDocumentParentMaterializerV2(),
    publisher: new NodeDocumentPublisher({
      ...operations.publisher,
      ...(operations.faultInjector === undefined
        ? {}
        : { faultInjector: operations.faultInjector })
    })
  };
}

export async function applyNodeDocumentationPlan(
  request: ApplyDocumentPlanRequest,
  authority: DocumentAuthorityRecompiler,
  operations: NodeDocumentWritingPrivateOperations = {}
): Promise<DocumentReceipt> {
  const contractValidator = new NodeDocumentContractValidator();
  const plan: DocumentPlan = await contractValidator.validatePlan(request.plan);
  const consumerRoot = await canonicalConsumerRoot(request.consumerRoot);
  // Preserve the microtask boundary before constructing the writer runtime.
  const coordinator = await Promise.resolve(createNodeDocumentTransactionCoordinator(consumerRoot));
  return applyDocumentPlan(
    { ...await runtime(consumerRoot, operations, authority), contractValidator, coordinator },
    {
      consumerRoot,
      plan,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }
  );
}

export async function recoverNodeDocumentationTransaction(
  request: RecoverDocumentTransactionRequest,
  authority: DocumentAuthorityRecompiler,
  operations: NodeDocumentWritingPrivateOperations = {}
): Promise<DocumentReceipt> {
  const consumerRoot = await canonicalConsumerRoot(request.consumerRoot);
  // Recovery shares the same scheduling boundary as apply.
  const coordinator = await Promise.resolve(createNodeDocumentTransactionCoordinator(consumerRoot));
  return recoverDocumentTransaction(
    { ...await runtime(consumerRoot, operations, authority), coordinator },
    {
      consumerRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }
  );
}
