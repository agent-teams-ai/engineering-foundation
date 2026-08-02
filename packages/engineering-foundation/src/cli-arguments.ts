import { resolve } from "node:path";

import { FoundationError } from "./errors.js";
import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "./scaffolding/service.js";

type OutputFormat = "json" | "text";

export interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly format: OutputFormat;
  readonly baseRef?: string;
}

const MAX_POSITIONAL_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({
  "--help": 0,
  "--version": 0,
  "-h": 0,
  "-v": 0,
  "assert-dev-only": 0,
  "assert-registry": 0,
  "agent-workflow": 1,
  attach: 1,
  check: 1,
  detach: 0,
  explain: 1,
  help: 0,
  "public-api-promote-release": 0,
  "scaffold-apply": 1,
  "scaffold-plan": 1,
  "scaffold-recover": 0,
  schema: 1,
  "self-check": 0,
  status: 0,
  version: 0
});

interface ArgumentState {
  readonly positional: string[];
  consumerRoot: string;
  configPath: string;
  configPathProvided: boolean;
  format: OutputFormat;
  baseRef?: string;
  optionsEnded: boolean;
}

function consumeArgument(
  args: readonly string[],
  index: number,
  state: ArgumentState
): number {
  const value = args[index];
  if (value === undefined) {
    return 0;
  }
  if (state.optionsEnded) {
    state.positional.push(value);
    return 0;
  }
  if (value === "--") {
    state.optionsEnded = true;
    return 0;
  }
  if (value === "--json") {
    state.format = "json";
    return 0;
  }
  if (value === "--consumer") {
    const candidate = args[index + 1];
    if (candidate === undefined || candidate.length === 0) {
      throw new FoundationError("CONSUMER_INVALID", "--consumer requires a path.");
    }
    state.consumerRoot = resolve(candidate);
    return 1;
  }
  if (value === "--base") {
    const candidate = args[index + 1];
    if (candidate === undefined || candidate.length === 0) {
      throw new FoundationError("CONSUMER_INVALID", "--base requires a Git ref.");
    }
    state.baseRef = candidate;
    return 1;
  }
  if (value === "--config") {
    const candidate = args[index + 1];
    if (candidate === undefined || candidate.length === 0) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        "--config requires a repository-relative path."
      );
    }
    state.configPath = candidate;
    state.configPathProvided = true;
    return 1;
  }
  if (value === "--format") {
    const candidate = args[index + 1];
    if (candidate !== "json" && candidate !== "text") {
      throw new FoundationError("CONSUMER_INVALID", "--format requires json or text.");
    }
    state.format = candidate;
    return 1;
  }
  if (value.startsWith("-")) {
    throw new FoundationError("CONSUMER_INVALID", `Unknown option: ${value}.`);
  }
  state.positional.push(value);
  return 0;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  const state: ArgumentState = {
    positional: [],
    configPath: DEFAULT_SCAFFOLDING_CONFIG_PATH,
    configPathProvided: false,
    consumerRoot: process.cwd(),
    format: "text",
    optionsEnded: false
  };

  for (let index = 1; index < args.length; index += 1) {
    index += consumeArgument(args, index, state);
  }

  const command = args[0] ?? "help";
  if (state.baseRef !== undefined && command !== "agent-workflow") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--base is supported only by agent-workflow changed."
    );
  }
  if (state.configPathProvided && command !== "scaffold-plan") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--config is supported only by scaffold-plan."
    );
  }
  const maximum = MAX_POSITIONAL_ARGUMENTS[command];
  if (maximum !== undefined && state.positional.length > maximum) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${command} accepts at most ${maximum} positional argument${maximum === 1 ? "" : "s"}.`
    );
  }

  return Object.freeze({
    command,
    positional: Object.freeze([...state.positional]),
    consumerRoot: state.consumerRoot,
    configPath: state.configPath,
    format: state.format,
    ...(state.baseRef === undefined ? {} : { baseRef: state.baseRef })
  });
}
