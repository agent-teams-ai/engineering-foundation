export interface AgentInstructionPaths {
  readonly canonical: string;
  readonly claude: string;
  readonly gemini: string;
  readonly copilot: string;
}

export interface AgentWorkflowScripts {
  readonly changed: string;
  readonly fast: string;
  readonly full: string;
}

export interface ChangedCheckPolicy {
  readonly id: string;
  readonly script: string;
  readonly extensions: readonly string[];
  readonly passPaths: boolean;
}

export interface RepositoryAgentWorkflowPolicy {
  readonly instructions: AgentInstructionPaths;
  readonly scripts: AgentWorkflowScripts;
  readonly changedChecks: readonly ChangedCheckPolicy[];
  readonly fullScanPaths: readonly string[];
}

export type InstructionFileEvidence =
  | { readonly kind: "file"; readonly source: string }
  | { readonly kind: "missing" | "symlink" | "invalid" };

export interface RepositoryAgentWorkflowEvidence {
  readonly instructionFiles: Readonly<Record<keyof AgentInstructionPaths, InstructionFileEvidence>>;
  readonly packageScripts: Readonly<Record<string, string>>;
}
