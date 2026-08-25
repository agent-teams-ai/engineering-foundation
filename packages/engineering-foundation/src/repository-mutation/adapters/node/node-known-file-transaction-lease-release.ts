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
  let releaseFailure: { readonly reason: unknown } | undefined;
  try {
    await options.lease.release({
      retainTransactionBarrier: options.retainTransactionBarrier
    });
  } catch (error) {
    releaseFailure = { reason: error };
  }
  if (releaseFailure === undefined) {return;}
  if (options.primaryFailure !== undefined) {
    throw new AggregateError(
      [options.primaryFailure.reason, releaseFailure.reason],
      options.jointFailureMessage,
      { cause: options.primaryFailure.reason }
    );
  }
  return Promise.reject(releaseFailure.reason);
}
