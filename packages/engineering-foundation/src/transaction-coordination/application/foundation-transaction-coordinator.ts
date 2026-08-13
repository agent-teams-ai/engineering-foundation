import { FoundationTransactionError } from "./foundation-transaction-error.js";
import type {
  FoundationMutationKind
} from "./model/transaction-status.js";
import type { InternalFoundationTransactionStatus } from "./model/internal-transaction-status.js";
import type { FoundationOperationLock } from "./ports/foundation-operation-lock.js";
import type { FoundationTransactionSlot } from "./ports/foundation-transaction-slot.js";

function preservePrimaryFailure(
  primaryFailure: unknown,
  releaseFailure: unknown
): unknown {
  if (!(primaryFailure instanceof Error)) {
    return new AggregateError(
      [primaryFailure, releaseFailure],
      "Foundation transaction and operation-lock release both failed."
    );
  }

  const previousCause = primaryFailure.cause;
  const releaseEvidence =
    previousCause === undefined
      ? releaseFailure
      : new AggregateError(
          [previousCause, releaseFailure],
          "The primary failure cause and operation-lock release both failed."
        );
  const attached = Reflect.defineProperty(primaryFailure, "cause", {
    configurable: true,
    value: releaseEvidence,
    writable: true
  });
  return attached
    ? primaryFailure
    : new AggregateError(
        [primaryFailure, releaseFailure],
        "Foundation transaction and operation-lock release both failed."
      );
}

function observedStatusFormat(status: InternalFoundationTransactionStatus): unknown {
  return Reflect.get(status, "format") as unknown;
}

function isDocumentRecoveryAllowed(
  status: InternalFoundationTransactionStatus,
  options: {
    readonly requestedMutation: FoundationMutationKind;
    readonly allowRecoveryOf?: "document-authoring" | "local-mode" | "scaffolding";
  }
): boolean {
  return (
    status.state === "pending" &&
    status.operationKind === "document-authoring" &&
    observedStatusFormat(status) === "document-authoring-envelope-v3" &&
    status.recovery.exactFoundationVersion === status.foundationVersion &&
    status.recovery.exactFoundationBuildIdentity ===
      status.foundationBuildIdentity &&
    options.allowRecoveryOf === "document-authoring" &&
    options.requestedMutation === "document-authoring" &&
    !status.diagnostics.some(
      ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
    )
  );
}

export interface FoundationTransactionLease {
  readonly status: InternalFoundationTransactionStatus;
  release(options?: { readonly retainTransactionBarrier?: boolean }): Promise<void>;
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

  async inspect(): Promise<InternalFoundationTransactionStatus> {
    return this.#slot.inspect();
  }

  async acquire(options: {
    readonly requestedMutation: FoundationMutationKind;
    readonly allowRecoveryOf?: "document-authoring" | "local-mode" | "scaffolding";
  }): Promise<FoundationTransactionLease> {
    const release = await this.#lock.acquire();
    let held = true;
    try {
      const status = await this.#slot.inspect();
      const scaffoldingRecoveryAllowed =
        status.state === "pending" &&
        status.operationKind === "scaffolding" &&
        observedStatusFormat(status) === "legacy-scaffolding-v1" &&
        options.allowRecoveryOf === status.operationKind &&
        options.requestedMutation === status.operationKind &&
        !status.diagnostics.some(
          ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
        );
      const localModeRecoveryAllowed =
        status.state === "pending" &&
        status.operationKind === "local-mode" &&
        observedStatusFormat(status) === "local-mode-v1" &&
        options.allowRecoveryOf === "local-mode" &&
        options.requestedMutation === "detach";
      const documentRecoveryAllowed = isDocumentRecoveryAllowed(status, options);
      if (
        status.state !== "idle" &&
        !scaffoldingRecoveryAllowed &&
        !localModeRecoveryAllowed &&
        !documentRecoveryAllowed
      ) {
        throw new FoundationTransactionError({
          requestedMutation: options.requestedMutation,
          status
        });
      }
      return {
        status,
        async release(releaseOptions) {
          if (held) {
            await release(releaseOptions);
            held = false;
          }
        }
      };
    } catch (error) {
      try {
        await release({ retainTransactionBarrier: true });
        held = false;
      } catch (releaseError) {
        throw preservePrimaryFailure(error, releaseError);
      }
      throw error;
    }
  }
}
