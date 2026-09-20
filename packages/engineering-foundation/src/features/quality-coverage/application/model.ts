import type { FoundationDiagnostic } from "../../validation-reporting/api.js";

/** Observations refer to consumer-owned classification, never filename heuristics. */
export interface QualitySource {
  readonly path: string;
  readonly owners: readonly string[];
  readonly suppressionCovered: boolean;
  /** Wiring evidence only; Foundation does not execute native gates. */
  readonly nativeGates?: readonly { readonly script: string; readonly reached: boolean }[];
}

export interface ProtectedSetting {
  /** Unique assignment observation within this configuration closure. */
  readonly observationId: string;
  readonly path: string;
  readonly name: string;
  readonly expected: string | number;
  readonly actual: string | number;
  readonly comparison: "equal" | "ceiling";
}

export type RequiredProtectedSetting = Omit<ProtectedSetting, "actual">;

interface RequiredQualityRoute {
  readonly entry: string;
  readonly mode: "scope" | "full";
  readonly reached: boolean;
}

export interface QualityCoverageObservation {
  readonly unclassifiedPackages?: readonly string[];
  readonly sources: readonly QualitySource[];
  readonly testPaths: readonly string[];
  /** Required names come from the versioned presets, independently of assignments. */
  readonly requiredSettings: readonly string[];
  /** Complete assignment identities from the accepted configuration groups. */
  readonly requiredSettingObservations: readonly RequiredProtectedSetting[];
  readonly settings: readonly ProtectedSetting[];
  /** Accepted profile identities, independent of observed script reachability. */
  readonly requiredRoutes: readonly Omit<RequiredQualityRoute, "reached">[];
  readonly routes: readonly RequiredQualityRoute[];
}

/** An execution session binds selection, context and lint to the same inputs. */
export interface QualityToolSession {
  select(signal?: AbortSignal): Promise<readonly string[]>;
  typeContext(signal?: AbortSignal): Promise<readonly string[]>;
  lint(signal?: AbortSignal): Promise<{
    readonly files: number;
    readonly diagnostics: readonly FoundationDiagnostic[];
  }>;
}

export interface QualityCoverageReader {
  read(consumerRoot: string, configPath: string, signal?: AbortSignal): Promise<QualityCoverageObservation>;
}

export interface QualityToolProvider {
  prepare(consumerRoot: string, configPath: string, sourcePaths: readonly string[], signal?: AbortSignal): Promise<QualityToolSession>;
}
