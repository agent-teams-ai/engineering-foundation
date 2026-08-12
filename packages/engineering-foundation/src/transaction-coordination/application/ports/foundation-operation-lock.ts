export interface FoundationOperationLock {
  acquire(): Promise<() => Promise<void>>;
}
