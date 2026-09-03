import {
  acquireMutationLease,
  releaseMutationLease,
  retainMutationBarrier,
  type MutationLease
} from "@agent-teams/repository-mutation/node";

import type {
  DocumentTransactionCoordinator,
  DocumentTransactionLease,
  DocumentTransactionStatus
} from "../../application/ports/document-transaction-coordinator.js";
import { inspectDocumentTransactionV2 } from "../../composition/inspect-document-transaction.js";

function projected(
  inspection: Awaited<ReturnType<typeof inspectDocumentTransactionV2>>
): DocumentTransactionStatus {
  if (inspection.state === "idle") {
    return { state: "idle" };
  }
  if (inspection.state === "recoverable") {
    return { state: "recoverable" };
  }
  return { state: "manual-recovery-required", reason: inspection.reason };
}

export class NodeDocumentTransactionCoordinator implements DocumentTransactionCoordinator {
  readonly #consumerRoot: string;

  constructor(consumerRoot: string) {
    this.#consumerRoot = consumerRoot;
  }

  async inspect(): Promise<DocumentTransactionStatus> {
    return projected(await inspectDocumentTransactionV2(this.#consumerRoot));
  }

  async acquire(_request: { readonly mode: "apply" | "recover" }): Promise<DocumentTransactionLease> {
    const lease: MutationLease = await acquireMutationLease(this.#consumerRoot);
    let held = true;
    try {
      const status = await this.inspect();
      return {
        status,
        release: async (options) => {
          if (!held) {
            return;
          }
          if (options?.retainTransactionBarrier === true) {
            retainMutationBarrier(lease);
          } else {
            try {
              if ((await this.inspect()).state !== "idle") {
                retainMutationBarrier(lease);
              }
            } catch {
              retainMutationBarrier(lease);
            }
          }
          await releaseMutationLease(lease);
          held = false;
        }
      };
    } catch (error) {
      retainMutationBarrier(lease);
      await releaseMutationLease(lease);
      held = false;
      throw error;
    }
  }
}

export function createNodeDocumentTransactionCoordinator(
  consumerRoot: string
): DocumentTransactionCoordinator {
  return new NodeDocumentTransactionCoordinator(consumerRoot);
}
