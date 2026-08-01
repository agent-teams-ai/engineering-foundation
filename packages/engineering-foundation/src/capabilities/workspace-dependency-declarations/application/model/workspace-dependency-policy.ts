export interface WorkspaceDependencyPolicy {
  readonly reservedScopes: readonly string[];
  readonly developmentOnlyPackages: readonly string[];
  readonly exactRegistryDevelopmentOnlyPackages: readonly string[];
}
