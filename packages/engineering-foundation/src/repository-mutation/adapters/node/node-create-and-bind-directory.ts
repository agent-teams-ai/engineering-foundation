interface NodeDirectoryCreateAndBindOperations<Parent, Observed, Bound> {
  readonly ambiguousError: (error: unknown) => Error;
  readonly bind: (bound: Bound) => Promise<void>;
  readonly captureParent: () => Promise<Parent>;
  readonly createAndObserve: (
    parent: Parent,
    markCreated: () => void
  ) => Promise<Observed>;
  readonly recapture: (parent: Parent, observed: Observed) => Promise<Bound>;
  readonly syncParent: (parent: Parent) => Promise<void>;
}

/**
 * Shared no-cancellation directory critical section. Callers retain their own
 * full-chain authority model, while this kernel fixes the mutation ordering.
 */
export async function createAndBindNodeDirectory<Parent, Observed, Bound>(
  operations: NodeDirectoryCreateAndBindOperations<Parent, Observed, Bound>
): Promise<Bound> {
  const parent = await operations.captureParent();
  const mutation = { created: false };
  try {
    const observed = await operations.createAndObserve(
      parent,
      () => { mutation.created = true; }
    );
    await operations.recapture(parent, observed);
    await operations.syncParent(parent);
    const bound = await operations.recapture(parent, observed);
    await operations.bind(bound);
    return bound;
  } catch (error) {
    if (!mutation.created) {
      throw error;
    }
    throw operations.ambiguousError(error);
  }
}
