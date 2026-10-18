import type { RepositoryPackageManager } from "../../../../process-execution/application/runtime-selection.js";

export interface QualityGateTask {
  readonly id: string;
  readonly needs: readonly string[];
  readonly after: readonly string[];
  readonly timeoutMs?: number;
}

export interface QualityGateProfile {
  readonly id: string;
  readonly packageManager: RepositoryPackageManager;
  readonly concurrency: number;
  readonly tasks: readonly QualityGateTask[];
}

export interface QualityGatePolicy {
  readonly profiles: readonly QualityGateProfile[];
}

export interface PackageScriptCatalog {
  readonly scripts: Readonly<Record<string, string>>;
}
