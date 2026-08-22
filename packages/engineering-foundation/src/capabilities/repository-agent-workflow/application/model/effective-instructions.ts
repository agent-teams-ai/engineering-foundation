export const DEFAULT_EFFECTIVE_INSTRUCTION_BUDGET_BYTES = 32 * 1024;

export const EFFECTIVE_INSTRUCTION_SEMANTICS =
  "foundation-safe-codex-default-project-instructions-v1" as const;

export const EFFECTIVE_INSTRUCTION_CANDIDATE_NAMES = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md"
] as const);

export type EffectiveInstructionCandidateObservation =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly sourceBytes: number;
      readonly bytes: Uint8Array | null;
    }
  | {
      readonly kind: "missing" | "not-file" | "symlink";
      readonly path: string;
    };

export interface EffectiveInstructionDirectoryObservation {
  readonly directory: string;
  readonly candidates: readonly EffectiveInstructionCandidateObservation[];
}

export interface EffectiveInstructionDiscovery {
  readonly targetPath: string;
  readonly targetDirectory: string;
  readonly directories: readonly string[];
}

export type EffectiveInstructionLayerStatus =
  | "applied"
  | "budget-exhausted"
  | "ignored-empty"
  | "truncated";

export interface EffectiveInstructionShadowedCandidate {
  readonly path: string;
  readonly reason: "higher-priority-candidate-selected";
}

export interface EffectiveInstructionLayerReport {
  readonly order: number;
  readonly directory: string;
  readonly scope: string;
  readonly selectedPath: string;
  readonly selectionReason: "first-regular-candidate";
  readonly applicabilityReason: "instruction-directory-contains-target";
  readonly status: EffectiveInstructionLayerStatus;
  readonly sourceBytes: number;
  readonly loadedBytes: number;
  readonly sourceDigest: `sha256:${string}` | null;
  readonly loadedDigest: `sha256:${string}`;
  readonly shadowed: readonly EffectiveInstructionShadowedCandidate[];
  readonly canOverrideEarlier: readonly string[];
}

export interface EffectiveInstructionsReport {
  readonly reportSchemaVersion: 1;
  readonly outcome: "resolved";
  readonly semantics: typeof EFFECTIVE_INSTRUCTION_SEMANTICS;
  readonly target: {
    readonly path: string;
    readonly directory: string;
    readonly reason: "repository-relative-file-selected-by-caller";
  };
  readonly budget: {
    readonly maximumBytes: number;
    readonly loadedBytes: number;
    readonly exhausted: boolean;
    readonly truncated: boolean;
  };
  readonly resolutionDigest: `sha256:${string}`;
  readonly layers: readonly EffectiveInstructionLayerReport[];
}
