export interface FoundationOperationReleaseOptions {
  readonly retainTransactionBarrier?: boolean;
}

export interface FoundationOperationLock {
  acquire(): Promise<
    (options?: FoundationOperationReleaseOptions) => Promise<void>
  >;
}
