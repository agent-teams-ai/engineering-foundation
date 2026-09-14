export interface QualityCoverageProfile {
  readonly sourcePolicyPath: string;
  readonly suppressionPolicyPath: string;
  readonly featureProfilePath: string;
  readonly lintConfigPath: string;
  /** Existing source boundary and consumer-owned native gate script identities. */
  readonly nativeChecks?: readonly { readonly boundaryId: string; readonly script: string }[];
  readonly compilerProjects: readonly string[];
  readonly scripts: {
    readonly fast: string;
    readonly full: string;
    readonly scope: string;
    readonly typed: string;
  };
}

export interface QualityTopology {
  readonly productionRoots: readonly string[];
  readonly applicationRoots: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly toolingFiles?: readonly string[];
  readonly modules: readonly {
    readonly root: string;
    readonly sourceRoot: string;
    readonly testRoots: readonly string[];
  }[];
}

export interface QualitySourceAuthority {
  readonly workspaceManifestPath: string;
  readonly boundaries: readonly {
    readonly id: string;
    readonly roots: readonly string[];
    readonly dependencyMode?: "runtime" | "development";
  }[];
}
