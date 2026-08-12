import { FoundationTransactionError } from "./foundation-transaction-error.js";
import type {
  FoundationMutationKind,
  FoundationTransactionStatus
} from "./model/transaction-status.js";
import type { FoundationOperationLock } from "./ports/foundation-operation-lock.js";
import type { FoundationTransactionSlot } from "./ports/foundation-transaction-slot.js";

export interface FoundationTransactionLease {
  readonly status: FoundationTransactionStatus;
  release(): Promise<void>;
}

export class FoundationTransactionCoordinator {
  readonly #lock: FoundationOperationLock;
  readonly #slot: FoundationTransactionSlot;

  constructor(options: {
    readonly lock: FoundationOperationLock;
    readonly slot: FoundationTransactionSlot;
  }) {
    this.#lock = options.lock;
    this.#slot = options.slot;
  }

  async inspect(): Promise<FoundationTransactionStatus> {
    return this.#slot.inspect();
  }

  async acquire(options: {
    readonly requestedMutation: FoundationMutationKind;
    readonly allowRecoveryOf?: "document-authoring" | "scaffolding";
  }): Promise<FoundationTransactionLease> {
    const release = await this.#lock.acquire();
    let held = true;
    try {
      const status = await this.#slot.inspect();
      const recoveryAllowed =
        status.state === "pending" &&
        options.allowRecoveryOf === status.operationKind &&
        status.format === "legacy-scaffolding-v1" &&
        !status.diagnostics.some(
          ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
        );
      if (status.state !== "idle" && !recoveryAllowed) {
        throw new FoundationTransactionError({
          requestedMutation: options.requestedMutation,
          status
        });
      }
      return {
        status,
        async release() {
          if (held) {
            held = false;
            await release();
          }
        }
      };
    } catch (error) {
      held = false;
      await release();
      throw error;
    }
  }
}
