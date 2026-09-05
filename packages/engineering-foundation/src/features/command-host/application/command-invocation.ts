export type OutputFormat = "json" | "text";

export interface CommandInvocation {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly format: OutputFormat;
  readonly baseRef?: string;
  readonly bufExecutablePath?: string;
  readonly write: boolean;
}

