import type {
  FoundationTransactionLease
} from "../../../transaction-coordination/application/foundation-transaction-coordinator.js";

/**
 * Releases a known-file lease without allowing a release failure to mask the
 * already-settled primary failure.
 */
export async function releaseKnownFileTransactionLease(options: {
  readonly jointFailureMessage: string;
  readonly lease: FoundationTransactionLease;
  readonly primaryFailure?: { readonly reason: unknown };
  readonly retainTransactionBarrier: boolean;
}): Promise<void> {
  try {
    await options.lease.release({
      retainTransactionBarrier: options.retainTransactionBarrier
    });
  } catch (releaseFailure) {
    if (options.primaryFailure !== undefined) {
      throw new AggregateError(
        [options.primaryFailure.reason, releaseFailure],
        options.jointFailureMessage,
        { cause: options.primaryFailure.reason }
      );
    }
    throw releaseFailure;
  }
}
