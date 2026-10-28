import type {
  NormalizedQualityGatePolicy,
  QualityGateCommand,
} from "../../../capabilities/quality-gate-runner/api.js";
import type { CapabilityInvocation } from "../../validation-reporting/api.js";
import type { FormatCoverageSelection } from "./format-coverage.js";

/** Execution plan normalized from the validated profile and independent census. */
export interface FormatCoverageObservation {
  readonly selection: FormatCoverageSelection;
  readonly paths: readonly string[];
  readonly fingerprints: ReadonlyMap<string, string>;
  readonly budgetMs: number;
  readonly authorities: readonly string[];
  readonly gate?: { readonly configPath: string; readonly profileId: string };
}

export interface FormatCoveragePorts {
  readonly nowMs: () => number;
  readonly read: (input: CapabilityInvocation) => Promise<FormatCoverageObservation>;
  readonly verify: (
    input: CapabilityInvocation,
    observed: FormatCoverageObservation,
  ) => Promise<void>;
  readonly prepareFormatter: (
    root: string,
    signal?: AbortSignal,
  ) => Promise<(files: readonly string[], signal: AbortSignal, budgetMs: number) => Promise<void>>;
  /** Absent in the static capability: it has no authority-process execution port. */
  readonly execution?: {
    readonly qualityGateActive: boolean;
    readonly runAuthorities: (
      input: CapabilityInvocation,
      observed: FormatCoverageObservation,
      budgetMs: number,
    ) => Promise<void>;
  };
}

export type FormatAuthorityPolicy = NormalizedQualityGatePolicy;
export type FormatAuthorityCommand = QualityGateCommand;
