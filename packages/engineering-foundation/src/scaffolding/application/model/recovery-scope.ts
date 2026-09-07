import type { RepositoryPath } from "./scaffold-values.js";

/** The immutable inward contract that may bind a v1 recovery attempt. */
export interface AuthorityScaffoldRecoveryScope {
  readonly projectId: string;
  readonly configPath: RepositoryPath;
  readonly targetCatalogPath: RepositoryPath;
  readonly compositionId: string;
}
