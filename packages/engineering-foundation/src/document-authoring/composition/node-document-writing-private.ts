import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  FOUNDATION_TRANSACTION_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../foundation-state-contract.js";
import { NodeDocumentContractValidator } from "../adapters/node/node-document-contract-validator.js";
import { NodeDocumentFileState } from "../adapters/node/node-document-file-state.js";
import { NodeDocumentJournalStore } from "../adapters/node/node-document-journal-store.js";
import {
  NodeDocumentPublisher,
  type NodeDocumentPublisherOperations
} from "../adapters/node/node-document-publisher.js";
import { createNodeDocumentTransactionCoordinator } from "../adapters/node/node-document-transaction-coordinator.js";
import type { DocumentPlan } from "../application/model/document-planning.js";
import type { DocumentReceipt } from "../application/model/document-receipt.js";
import {
  applyDocumentPlan,
  type ApplyDocumentPlanRequest
} from "../application/use-cases/apply-document-plan.js";
import type {
  DocumentTransactionFaultInjector,
  DocumentTransactionFaultPoint
} from "../application/use-cases/document-transaction-continuation.js";
import {
  recoverDocumentTransaction,
  type RecoverDocumentTransactionRequest
} from "../application/use-cases/recover-document-transaction.js";
import { NodeDocumentAuthorityRecompiler } from "./node-document-authority-recompiler.js";

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
  return realpath(resolve(consumerRoot));
}

function runtime(
  consumerRoot: string,
  operations: NodeDocumentWritingPrivateOperations
) {
  const faultInjector: DocumentTransactionFaultInjector | undefined =
    operations.faultInjector;
  return {
    authority: new NodeDocumentAuthorityRecompiler(),
    fileState: new NodeDocumentFileState(),
    ...(faultInjector === undefined ? {} : { faultInjector }),
    journal: new NodeDocumentJournalStore(journalPath(consumerRoot)),
    publisher: new NodeDocumentPublisher({
      ...operations.publisher,
      ...(operations.faultInjector === undefined
        ? {}
        : { faultInjector: operations.faultInjector })
    })
  };
}

export async function applyNodeDocumentationPlanPrivately(
  request: ApplyDocumentPlanRequest,
  operations: NodeDocumentWritingPrivateOperations = {}
): Promise<DocumentReceipt> {
  const contractValidator = new NodeDocumentContractValidator();
  const plan: DocumentPlan = await contractValidator.validatePlan(request.plan);
  const consumerRoot = await canonicalConsumerRoot(request.consumerRoot);
  const coordinator = await createNodeDocumentTransactionCoordinator(consumerRoot);
  return applyDocumentPlan(
    { ...runtime(consumerRoot, operations), contractValidator, coordinator },
    {
      consumerRoot,
      plan,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }
  );
}

export async function recoverNodeDocumentationTransactionPrivately(
  request: RecoverDocumentTransactionRequest,
  operations: NodeDocumentWritingPrivateOperations = {}
): Promise<DocumentReceipt> {
  const consumerRoot = await canonicalConsumerRoot(request.consumerRoot);
  const coordinator = await createNodeDocumentTransactionCoordinator(consumerRoot);
  return recoverDocumentTransaction(
    { ...runtime(consumerRoot, operations), coordinator },
    {
      consumerRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }
  );
}
