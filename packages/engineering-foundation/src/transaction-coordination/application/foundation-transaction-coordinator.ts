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

function isKnownFileRecoveryAllowed(
  status: InternalFoundationTransactionStatus,
  options: {
    readonly requestedMutation: FoundationMutationKind;
    readonly allowRecoveryOf?: "document-authoring" | "known-file-transaction" | "local-mode" | "scaffolding";
  }
): boolean {
  return status.state === "pending" &&
    status.operationKind === "known-file-transaction" &&
    status.recoveryArtifacts !== undefined &&
    status.recoveryArtifacts.schemaVersion === 6 &&
    status.recoveryArtifacts.ownerArtifact.name === "@agent-teams/repository-mutation" &&
    status.recoveryArtifacts.kernelArtifact.name === status.recoveryArtifacts.ownerArtifact.name &&
    status.recoveryArtifacts.ownerArtifact.version === status.foundationVersion &&
    status.recoveryArtifacts.ownerArtifact.buildIdentity === status.foundationBuildIdentity &&
    status.recoveryArtifacts.kernelArtifact.version === status.recoveryArtifacts.ownerArtifact.version &&
    status.recoveryArtifacts.kernelArtifact.buildIdentity === status.recoveryArtifacts.ownerArtifact.buildIdentity &&
    status.recovery.exactFoundationVersion === status.foundationVersion &&
    status.recovery.exactFoundationBuildIdentity === status.foundationBuildIdentity &&
    options.allowRecoveryOf === "known-file-transaction" &&
    options.requestedMutation === "known-file-transaction" &&
    !status.diagnostics.some(({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH");
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
    readonly allowRecoveryOf?: "document-authoring" | "known-file-transaction" | "local-mode" | "scaffolding";
  }): Promise<FoundationTransactionLease> {
    const release = await this.#lock.acquire();
    let held = true;
    try {
      const status = await this.#slot.inspect();
      const scaffoldingRecoveryAllowed =
        status.state === "pending" &&
        status.operationKind === "scaffolding" &&
        ["foundation-scaffolding-envelope-v6", "legacy-scaffolding-v1"].includes(
          status.format
        ) &&
        options.allowRecoveryOf === status.operationKind &&
        options.requestedMutation === status.operationKind &&
        !status.diagnostics.some(
          ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
        );
      const localModeRecoveryAllowed =
        status.state === "pending" &&
        status.operationKind === "local-mode" &&
        ["local-mode-v1"].includes(status.format) &&
        options.allowRecoveryOf === "local-mode" &&
        options.requestedMutation === "detach";
      const knownFileRecoveryAllowed = isKnownFileRecoveryAllowed(status, options);
      if (
        status.state !== "idle" &&
        !scaffoldingRecoveryAllowed &&
        !localModeRecoveryAllowed &&
        !knownFileRecoveryAllowed
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
