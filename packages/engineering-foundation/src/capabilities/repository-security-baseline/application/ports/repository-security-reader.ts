import type {
  RepositorySecurityEvidence,
  RepositorySecurityPolicy
} from "../model/repository-security.js";

export interface RepositorySecurityReader {
  read(
    consumerRoot: string,
    policy: RepositorySecurityPolicy,
    signal?: AbortSignal
  ): Promise<RepositorySecurityEvidence>;
}
