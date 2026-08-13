import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  FOUNDATION_TRANSACTION_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../foundation-state-contract.js";
import { NodeDocumentContractValidator } from "../adapters/node/node-document-contract-validator.js";
import { NodeDocumentFileState } from "../adapters/node/node-document-file-state.js";
import { NodeDocumentJournalStore } from "../adapters/node/node-document-journal-store.js";
import { NodeDocumentPublisher } from "../adapters/node/node-document-publisher.js";
import { createNodeDocumentTransactionCoordinator } from "../adapters/node/node-document-transaction-coordinator.js";
import type { DocumentPlan } from "../application/model/document-planning.js";
import type { DocumentReceipt } from "../application/model/document-receipt.js";
import {
  applyDocumentPlan,
  type ApplyDocumentPlanRequest
} from "../application/use-cases/apply-document-plan.js";
import {
  recoverDocumentTransaction,
  type RecoverDocumentTransactionRequest
} from "../application/use-cases/recover-document-transaction.js";
import { NodeDocumentAuthorityRecompiler } from "./node-document-authority-recompiler.js";

function journalPath(consumerRoot: string): string {
  return join(
    consumerRoot,
    LOCAL_STATE_DIRECTORY,
    FOUNDATION_TRANSACTION_FILE
  );
}

async function canonicalConsumerRoot(consumerRoot: string): Promise<string> {
  return realpath(resolve(consumerRoot));
}

function runtime(consumerRoot: string) {
  return {
    authority: new NodeDocumentAuthorityRecompiler(),
    fileState: new NodeDocumentFileState(),
    journal: new NodeDocumentJournalStore(journalPath(consumerRoot)),
    publisher: new NodeDocumentPublisher()
  };
}

/** Closed Node composition for durable, create-only document publication. */
export async function applyNodeDocumentationPlan(
  request: ApplyDocumentPlanRequest
): Promise<DocumentReceipt> {
  const contractValidator = new NodeDocumentContractValidator();
  // Snapshot hostile caller input before the first composition-level await.
  const plan: DocumentPlan = await contractValidator.validatePlan(request.plan);
  const consumerRoot = await canonicalConsumerRoot(request.consumerRoot);
  const coordinator = await createNodeDocumentTransactionCoordinator(consumerRoot);
  return applyDocumentPlan(
    {
      ...runtime(consumerRoot),
      contractValidator,
      coordinator
    },
    {
      consumerRoot,
      plan,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }
  );
}

/** Closed Node composition for exact-version document transaction recovery. */
export async function recoverNodeDocumentationTransaction(
  request: RecoverDocumentTransactionRequest
): Promise<DocumentReceipt> {
  const consumerRoot = await canonicalConsumerRoot(request.consumerRoot);
  const coordinator = await createNodeDocumentTransactionCoordinator(consumerRoot);
  return recoverDocumentTransaction(
    {
      ...runtime(consumerRoot),
      coordinator
    },
    {
      consumerRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    }
  );
}
