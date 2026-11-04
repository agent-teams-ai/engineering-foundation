/** Optional caller resource accounting; inode/link identity always remains owner-observed. */
export interface RetiredTemporaryInspectionBudget {
  beforeRead(requestedMaxBytes: number): number;
  afterRead(actualOrConservativeBytes: number): void;
  checkpoint(): void;
}
