import type { DocumentTransactionLease } from "../ports/document-transaction-coordinator.js";

export interface DocumentTransactionExecution<T> {
  readonly primaryFailure?: unknown;
  readonly retainTransactionBarrier: boolean;
  readonly value: T;
}

type SettledExecution<T> =
  | { readonly state: "fulfilled"; readonly execution: DocumentTransactionExecution<T> }
  | { readonly state: "rejected"; readonly error: unknown };

async function settle<T>(operation: () => Promise<DocumentTransactionExecution<T>>):
Promise<SettledExecution<T>> {
  try {
    return { execution: await operation(), state: "fulfilled" };
  } catch (error) {
    return { error, state: "rejected" };
  }
}

function primaryFailure<T>(settled: SettledExecution<T>): unknown {
  return settled.state === "rejected"
    ? settled.error
    : settled.execution.primaryFailure;
}

/** Releases a lease without allowing release control flow to replace the primary outcome. */
export async function executeWithDocumentTransactionLease<T>(
  lease: DocumentTransactionLease,
  operation: () => Promise<DocumentTransactionExecution<T>>,
  jointFailureMessage: string
): Promise<T> {
  const settled = await settle(operation);
  const retainTransactionBarrier = settled.state === "rejected" ||
    settled.execution.retainTransactionBarrier;
  let releaseFailure: unknown;
  try {
    await lease.release({ retainTransactionBarrier });
  } catch (error) {
    releaseFailure = error;
  }
  const primary = primaryFailure(settled);
  if (releaseFailure !== undefined && primary !== undefined) {
    throw new AggregateError([primary, releaseFailure], jointFailureMessage, {
      cause: primary
    });
  }
  if (releaseFailure !== undefined) {
    return Promise.reject(releaseFailure);
  }
  if (settled.state === "rejected") {
    return Promise.reject(settled.error);
  }
  return settled.execution.value;
}
