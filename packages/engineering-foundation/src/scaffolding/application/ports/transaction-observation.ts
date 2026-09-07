import type { RepositoryMutationArtifactIdentity } from "@agent-teams/repository-mutation";

/** Exact installed owner/kernel observations remain owned by transaction coordination. */
export type ScaffoldTransactionArtifacts = () => Promise<{
  readonly owner: RepositoryMutationArtifactIdentity;
  readonly kernel: RepositoryMutationArtifactIdentity;
}>;

export interface ScaffoldLegacyDigests {
  readonly journalPlanDigest: (value: unknown) => string;
  readonly assertEnvelopeDigests: (value: Record<string, unknown>) => void;
}
