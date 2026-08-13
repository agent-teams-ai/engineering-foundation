export interface OwnedTemporaryCleanupTransition {
  complete(): Promise<void>;
}

export interface OwnedTemporaryCleanupTransitionPort {
  begin(): Promise<OwnedTemporaryCleanupTransition>;
}
