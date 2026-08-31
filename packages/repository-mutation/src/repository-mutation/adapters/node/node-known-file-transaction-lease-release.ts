import {
  releaseMutationLease,
  retainMutationBarrier,
  type MutationLease
} from "../../../transaction-coordination/mutation-lease.js";

/**
 * Releases a known-file lease without allowing a release failure to mask the
 * already-settled primary failure.
 */
export async function releaseKnownFileTransactionLease(options: {
  readonly jointFailureMessage: string;
  readonly lease: MutationLease;
  readonly primaryFailure?: { readonly reason: unknown };
  readonly retainTransactionBarrier: boolean;
}): Promise<void> {
  return releaseKnownFileTransactionLeaseWith({
    jointFailureMessage: options.jointFailureMessage,
    ...(options.primaryFailure === undefined ? {} : { primaryFailure: options.primaryFailure }),
    release: async () => {
      if (options.retainTransactionBarrier) {retainMutationBarrier(options.lease);}
      await releaseMutationLease(options.lease);
    }
  });
}

export async function releaseKnownFileTransactionLeaseWith(options: {
  readonly jointFailureMessage: string;
  readonly primaryFailure?: { readonly reason: unknown };
  readonly release: () => Promise<void>;
}): Promise<void> {
  let releaseFailure: { readonly reason: unknown } | undefined;
  try {
    await options.release();
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
