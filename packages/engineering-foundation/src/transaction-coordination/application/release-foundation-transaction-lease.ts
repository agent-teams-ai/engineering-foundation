import type { FoundationTransactionLease } from "./foundation-transaction-coordinator.js";

function combinedInspectionAndReleaseFailure(
  inspectionError: unknown,
  releaseError: unknown
): Error {
  return new Error(
    "Foundation transaction evidence inspection and barrier retention both failed.",
    {
      cause: new AggregateError(
        [inspectionError, releaseError],
        "Transaction evidence inspection and operation-lock release failed."
      )
    }
  );
}

export async function releaseFoundationTransactionLeaseSafely(options: {
  readonly lease: FoundationTransactionLease;
  readonly inspectRetainTransactionBarrier: () => Promise<boolean>;
}): Promise<void> {
  let retainTransactionBarrier: boolean;
  try {
    retainTransactionBarrier =
      await options.inspectRetainTransactionBarrier();
  } catch (inspectionError) {
    try {
      await options.lease.release({ retainTransactionBarrier: true });
    } catch (releaseError) {
      throw combinedInspectionAndReleaseFailure(
        inspectionError,
        releaseError
      );
    }
    throw inspectionError;
  }
  await options.lease.release({ retainTransactionBarrier });
}
