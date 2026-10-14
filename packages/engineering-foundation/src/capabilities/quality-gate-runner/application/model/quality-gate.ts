import type { RepositoryPackageManager } from "../../../../process-execution/application/runtime-selection.js";

export interface QualityGateTask {
  readonly id: string;
  readonly needs: readonly string[];
  readonly after: readonly string[];
  readonly timeoutMs?: number;
}

export interface QualityGateProfile {
  readonly id: string;
  readonly concurrency: number;
  readonly tasks: readonly QualityGateTask[];
}

export interface QualityGatePolicy {
  readonly packageManager: "pnpm";
  readonly profiles: readonly QualityGateProfile[];
}

export interface NormalizedQualityGateProfile extends QualityGateProfile {
  readonly packageManager: RepositoryPackageManager;
}

export interface NormalizedQualityGatePolicy {
  readonly profiles: readonly NormalizedQualityGateProfile[];
}

export type QualityGatePolicyInput = QualityGatePolicy | NormalizedQualityGatePolicy;

export interface PackageScriptCatalog {
  readonly scripts: Readonly<Record<string, string>>;
}
