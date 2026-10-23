import type {
  QualifiedDocsCohortBindingV2,
  UnselectedCohortV3,
} from "../packages/docs-protocol-agent-teams/dist/qualification/index.js";

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

export type CanaryPackageKey =
  | "repositoryMutation"
  | "documentAuthoring"
  | "docsProtocol"
  | "docsProtocolAgentTeams"
  | "engineeringFoundation";

export interface CanaryPackageCoordinate {
  readonly direct: boolean;
  readonly integrity: `sha512-${string}`;
  readonly key: CanaryPackageKey;
  readonly name: `@agent-teams/${string}`;
  readonly version: string;
}

export type CanaryCohortV3 = Omit<UnselectedCohortV3, "canaryRepositoryIds" | "lifecycleState">;

export type CanaryCohort = QualifiedDocsCohortBindingV2 | CanaryCohortV3;

export interface ProjectedCohortAuthority {
  readonly cohort: CanaryCohort;
  readonly path: "governance/docs-qualified-cohorts.json";
  readonly repository: "agent-teams-ai/.github";
  readonly revision: string;
}

export interface ProjectedCanaryAuthority {
  readonly cohort: CanaryCohort;
  readonly coordinates: readonly CanaryPackageCoordinate[];
  readonly roots: readonly CanaryPackageCoordinate[];
  readonly central: {
    readonly path: "governance/docs-qualified-cohorts.json";
    readonly repository: "agent-teams-ai/.github";
    readonly revision: string;
    readonly schemaPath: "governance/docs-qualified-cohorts.schema.json";
  };
  readonly expectedCommit: string;
  readonly registry: "https://registry.npmjs.org/";
  readonly source: {
    readonly ref: "refs/heads/main";
    readonly repository: "https://github.com/agent-teams-ai/engineering-foundation";
    readonly workflow: ".github/workflows/release.yml";
  };
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
}) => ProjectedCohortAuthority | Promise<ProjectedCohortAuthority>;

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
