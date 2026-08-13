import type {
  DocumentTransactionCoordinator,
  DocumentTransactionLease,
  DocumentTransactionStatus
} from "../../application/ports/document-transaction-coordinator.js";
import { createNodeFoundationTransactionCoordinator } from "../../../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import type {
  FoundationTransactionCoordinator,
  FoundationTransactionLease
} from "../../../transaction-coordination/application/foundation-transaction-coordinator.js";
import type { FoundationTransactionStatus } from "../../../transaction-coordination/application/model/transaction-status.js";

interface FoundationCoordinator {
  inspect(): Promise<FoundationTransactionStatus>;
  acquire(options: {
    readonly requestedMutation: "document-authoring";
    readonly allowRecoveryOf?: "document-authoring";
  }): Promise<FoundationTransactionLease>;
}

function observedProperty(value: object, property: string): unknown {
  return Reflect.get(value, property) as unknown;
}

function isExactDocumentRecovery(
  status: FoundationTransactionStatus
): boolean {
  return (
    status.state === "pending" &&
    status.operationKind === "document-authoring" &&
    observedProperty(status, "format") === "document-authoring-envelope-v3" &&
    observedProperty(status.recovery, "commandId") === "docs-recover" &&
    status.recovery.exactFoundationVersion === status.foundationVersion &&
    status.recovery.exactFoundationBuildIdentity ===
      status.foundationBuildIdentity &&
    !status.diagnostics.some(
      ({ code }) => code === "FOUNDATION_TRANSACTION_VERSION_MISMATCH"
    )
  );
}

function manualReason(status: Exclude<FoundationTransactionStatus, {
  readonly state: "idle";
}>): string {
  if (status.state === "manual-recovery-required") {
    return status.reason;
  }
  return (
    status.diagnostics[0]?.message ??
    `A ${status.operationKind} Foundation transaction blocks document authoring.`
  );
}

function toDocumentStatus(
  status: FoundationTransactionStatus
): DocumentTransactionStatus {
  if (status.state === "idle") {
    return { state: "idle" };
  }
  return isExactDocumentRecovery(status)
    ? { state: "recoverable" }
    : { state: "manual-recovery-required", reason: manualReason(status) };
}

function combinedReleaseFailure(
  inspectionError: unknown,
  releaseError: unknown
): Error {
  return new Error(
    "Document transaction inspection and barrier retention both failed.",
    {
      cause: new AggregateError(
        [inspectionError, releaseError],
        "Transaction evidence inspection and operation-lock release failed."
      )
    }
  );
}

async function releaseSafely(options: {
  readonly coordinator: FoundationCoordinator;
  readonly lease: FoundationTransactionLease;
  readonly retainRequested: boolean;
}): Promise<void> {
  let status: FoundationTransactionStatus;
  try {
    status = await options.coordinator.inspect();
  } catch (inspectionError) {
    try {
      await options.lease.release({ retainTransactionBarrier: true });
    } catch (releaseError) {
      throw combinedReleaseFailure(inspectionError, releaseError);
    }
    throw inspectionError;
  }
  await options.lease.release({
    retainTransactionBarrier:
      options.retainRequested || status.state !== "idle"
  });
}

export class NodeDocumentTransactionCoordinator
  implements DocumentTransactionCoordinator {
  readonly #coordinator: FoundationCoordinator;

  constructor(coordinator: FoundationCoordinator) {
    this.#coordinator = coordinator;
  }

  async inspect(): Promise<DocumentTransactionStatus> {
    return toDocumentStatus(await this.#coordinator.inspect());
  }

  async acquire(request: {
    readonly mode: "apply" | "recover";
  }): Promise<DocumentTransactionLease> {
    const lease = await this.#coordinator.acquire({
      requestedMutation: "document-authoring",
      ...(request.mode === "recover"
        ? { allowRecoveryOf: "document-authoring" as const }
        : {})
    });
    let held = true;
    return {
      status: toDocumentStatus(lease.status),
      release: async (releaseOptions) => {
        if (!held) {
          return;
        }
        await releaseSafely({
          coordinator: this.#coordinator,
          lease,
          retainRequested:
            releaseOptions?.retainTransactionBarrier === true
        });
        held = false;
      }
    };
  }
}

export async function createNodeDocumentTransactionCoordinator(
  consumerRoot: string
): Promise<DocumentTransactionCoordinator> {
  const coordinator: FoundationTransactionCoordinator =
    await createNodeFoundationTransactionCoordinator(consumerRoot);
  return new NodeDocumentTransactionCoordinator(coordinator);
}
