export interface CanaryInputs {
  readonly authorityRevision: string;
  readonly cohortId: string;
  readonly expectedCommit: string;
}

export interface CanaryRepository {
  readonly provider: "github";
  readonly id: string;
  readonly nameWithOwner: string;
}

export interface ProjectedCanaryAuthority {
  readonly cohort: Record<string, unknown>;
  readonly coordinates: readonly Record<string, unknown>[];
  readonly roots: readonly Record<string, unknown>[];
  readonly central: Record<string, unknown>;
}

export type CanaryAuthorityFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CanaryAuthorityProjector = (input: {
  readonly cohortId: string;
  readonly registry: Record<string, unknown>;
  readonly repository: CanaryRepository;
  readonly revision: string;
}) => ProjectedCanaryAuthority | Promise<ProjectedCanaryAuthority>;

export function parseCanaryInputs(input: {
  readonly authorityRevision: string;
  readonly cohortId: string;
  readonly expectedCommit: string;
}): CanaryInputs;

export function observeCentralCohortAuthority(
  request: {
    readonly inputs: CanaryInputs;
    readonly repository: CanaryRepository;
  },
  options?: {
    readonly fetcher?: CanaryAuthorityFetcher;
    readonly projectAuthority?: CanaryAuthorityProjector;
  },
): Promise<ProjectedCanaryAuthority>;
