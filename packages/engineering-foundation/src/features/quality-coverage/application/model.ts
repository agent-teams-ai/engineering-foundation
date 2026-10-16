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

/** Source-bound syntax evidence from the adapter; application policy owns diagnostics. */
export interface ExplicitUnknownFinding {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly sha256: string;
}

/** An execution session binds selection, context and lint to the same inputs. */
export interface QualityToolSession {
  select(signal?: AbortSignal): Promise<readonly string[]>;
  typeContext(signal?: AbortSignal): Promise<readonly string[]>;
  lint(signal?: AbortSignal): Promise<{
    readonly files: number;
    readonly diagnostics: readonly FoundationDiagnostic[];
  }>;
  /** Full mode only: source-bound syntax governance over the production inventory. */
  explicitUnknown(signal?: AbortSignal): Promise<readonly ExplicitUnknownFinding[]>;
}

export interface QualityCoverageReader {
  read(consumerRoot: string, configPath: string, signal?: AbortSignal): Promise<QualityCoverageObservation>;
}

export interface QualityToolProvider {
  prepare(consumerRoot: string, configPath: string, sourcePaths: readonly string[], signal?: AbortSignal): Promise<QualityToolSession>;
}

/** A measured rule fired with a message that carries no value; the producer maps it to its own input error. */
export class OxlintMeasuredValueMissingError extends Error {
  override readonly name = "OxlintMeasuredValueMissingError";
  constructor(readonly rule: string) {
    super(`Measured rule ${rule} has no parenthesized value in its Oxlint message.`);
  }
}

/** The findings of all batches and the number of files Oxlint linted. */
export interface OxlintFindings {
  readonly files: number;
  readonly findings: readonly OxlintFinding[];
}

/** One lint rule of one file: how often it fired and, for a measured rule, the largest measured value. */
export interface OxlintFinding {
  readonly path: string;
  /** `<plugin>/<rule>`, for example `eslint/max-lines`. */
  readonly rule: string;
  readonly count: number;
  readonly max?: number;
}
