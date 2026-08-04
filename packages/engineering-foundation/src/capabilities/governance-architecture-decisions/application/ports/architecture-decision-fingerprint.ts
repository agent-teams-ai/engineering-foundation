export interface ArchitectureDecisionFingerprint {
  digest(payload: string): string;
}
