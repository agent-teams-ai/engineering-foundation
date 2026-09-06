import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "../../../scaffolding/scaffold-defaults.js";

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


export function defaultCommandConfigPath(): string {
  return DEFAULT_SCAFFOLDING_CONFIG_PATH;
}
