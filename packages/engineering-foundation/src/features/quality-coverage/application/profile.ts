export interface QualityCoverageProfile {
  readonly schemaVersion: 5;
  readonly budgetMs: number;
  readonly topologyPath: string;
  readonly toolchainConfigPath: string;
  readonly sourcePolicyPath: string;
  readonly suppressionPolicyPath: string;
  readonly lintConfigPath: string;
  readonly bridgeAdmissionsPath?: string;
  /** Existing source boundary and consumer-owned native gate script identities. */
  readonly nativeChecks?: readonly { readonly boundaryId: string; readonly script: string }[];
  /** Exact nonrunnable inputs; source ownership remains authoritative. */
  readonly assets?: readonly {
    readonly path: string;
    readonly kind: "protobuf" | "sql-migration";
    readonly boundaryId: string;
    readonly script: string;
  }[];
  readonly compilerProjects: readonly string[];
  readonly scripts: {
    readonly fast: string;
    readonly full: string;
    readonly scope: string;
    readonly typed: string;
  };
}

export interface QualityTopology {
  readonly schemaVersion: 1;
  readonly censusRoots: readonly string[];
  readonly packageRoots: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly testRoots: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly toolingFiles: readonly string[];
  readonly derivedFrom?: readonly { readonly path: string; readonly sha256: string }[];
}

export interface QualitySourceAuthority {
  readonly workspaceManifestPath: string;
  readonly boundaries: readonly {
    readonly id: string;
    readonly roots: readonly string[];
    readonly dependencyMode?: "runtime" | "development";
  }[];
}
