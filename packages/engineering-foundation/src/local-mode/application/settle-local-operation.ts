import { FoundationError } from "../../features/validation-reporting/api.js";

/** Settle one local lifecycle operation and its acquired lease without losing either failure. */
export async function settleLocalOperation<T>(
  operation: () => Promise<T>,
  finalize: () => Promise<void>,
): Promise<T> {
  let completed: { readonly value: T } | undefined;
  let failure: { readonly value: unknown } | undefined;
  try {
    completed = { value: await operation() };
  } catch (error) {
    failure = { value: error };
  }
  try {
    await finalize();
  } catch (error) {
    if (failure === undefined) {
      throw error;
    }
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Local operation and finalization failed; reconcile retained recovery evidence.",
      {
        cause: new AggregateError(
          [failure.value, error],
          "Local operation and finalization failures in observation order.",
        ),
      },
    );
  }
  if (failure !== undefined) {
    throw failure.value;
  }
  if (completed === undefined) {
    throw new Error("Local operation has no settled result.");
  }
  return completed.value;
}
