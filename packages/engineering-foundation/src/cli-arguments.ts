import { resolve } from "node:path";

import { FoundationError } from "./errors.js";
import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "./scaffolding/scaffold-defaults.js";

type OutputFormat = "json" | "text";

export interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly format: OutputFormat;
  readonly documentId?: string;
  readonly documentOwner?: string;
  readonly documentProfilePath: string;
  readonly documentStatus?: string;
  readonly documentType?: string;
  readonly baseRef?: string;
  readonly bufExecutablePath?: string;
  readonly write: boolean;
}

const MAX_POSITIONAL_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({
  "--help": 0,
  "--version": 0,
  "-h": 0,
  "-v": 0,
  "assert-dev-only": 0,
  "assert-registry": 0,
  "agent-workflow": 1,
  "architecture-decisions-promote-baseline": 0,
  attach: 1,
  check: 1,
  detach: 0,
  "docs.find": 1,
  explain: 1,
  help: 0,
  "public-api-promote-release": 0,
  "protobuf-qualify-breaking": 0,
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
  documentId?: string;
  documentOwner?: string;
  documentProfilePath: string;
  documentProfilePathProvided: boolean;
  documentStatus?: string;
  documentType?: string;
  baseRef?: string;
  bufExecutablePath?: string;
  write: boolean;
  optionsEnded: boolean;
}

const DEFAULT_DOCUMENT_AUTHORING_PROFILE_PATH =
  "architecture/foundation/document-authoring.yaml";

function consumeDocumentOption(
  args: readonly string[],
  index: number,
  state: ArgumentState
): number | undefined {
  const value = args[index];
  const field = value === "--id"
    ? "documentId"
    : value === "--owner"
      ? "documentOwner"
      : value === "--profile"
        ? "documentProfilePath"
        : value === "--status"
          ? "documentStatus"
          : value === "--type"
            ? "documentType"
            : undefined;
  if (field === undefined) {
    return undefined;
  }
  const candidate = args[index + 1];
  if (candidate === undefined || candidate.length === 0) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${value} requires a value.`
    );
  }
  state[field] = candidate;
  if (field === "documentProfilePath") {
    state.documentProfilePathProvided = true;
  }
  return 1;
}

function consumeQualificationOption(
  args: readonly string[],
  index: number,
  state: ArgumentState
): number | undefined {
  const value = args[index];
  if (value === "--write") {
    state.write = true;
    return 0;
  }
  if (value !== "--buf-executable") {
    return undefined;
  }
  const candidate = args[index + 1];
  if (candidate === undefined || candidate.length === 0) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--buf-executable requires an absolute path."
    );
  }
  state.bufExecutablePath = candidate;
  return 1;
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
  const documentOption = consumeDocumentOption(args, index, state);
  if (documentOption !== undefined) {
    return documentOption;
  }
  const qualificationOption = consumeQualificationOption(args, index, state);
  if (qualificationOption !== undefined) {
    return qualificationOption;
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

function validateCommandOptions(command: string, state: ArgumentState): void {
  const documentOptionsProvided =
    state.documentId !== undefined ||
    state.documentOwner !== undefined ||
    state.documentProfilePathProvided ||
    state.documentStatus !== undefined ||
    state.documentType !== undefined;
  if (documentOptionsProvided && command !== "docs.find") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--id, --owner, --profile, --status, and --type are supported only by docs find."
    );
  }
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
  if (state.write && command !== "protobuf-qualify-breaking") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--write is supported only by protobuf-qualify-breaking."
    );
  }
  if (
    state.bufExecutablePath !== undefined &&
    command !== "protobuf-qualify-breaking"
  ) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--buf-executable is supported only by protobuf-qualify-breaking."
    );
  }
}

function validatePositionalArguments(
  command: string,
  positional: readonly string[]
): void {
  const maximum = MAX_POSITIONAL_ARGUMENTS[command];
  if (maximum !== undefined && positional.length > maximum) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${command} accepts at most ${maximum} positional argument${maximum === 1 ? "" : "s"}.`
    );
  }
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  const state: ArgumentState = {
    positional: [],
    configPath: DEFAULT_SCAFFOLDING_CONFIG_PATH,
    configPathProvided: false,
    consumerRoot: process.cwd(),
    documentProfilePath: DEFAULT_DOCUMENT_AUTHORING_PROFILE_PATH,
    documentProfilePathProvided: false,
    format: "text",
    write: false,
    optionsEnded: false
  };

  const command = args[0] === "docs"
    ? `docs.${args[1] ?? ""}`
    : (args[0] ?? "help");
  const firstArgumentIndex = args[0] === "docs" ? 2 : 1;
  for (let index = firstArgumentIndex; index < args.length; index += 1) {
    index += consumeArgument(args, index, state);
  }

  validateCommandOptions(command, state);
  validatePositionalArguments(command, state.positional);

  return Object.freeze({
    command,
    positional: Object.freeze([...state.positional]),
    consumerRoot: state.consumerRoot,
    configPath: state.configPath,
    format: state.format,
    documentProfilePath: state.documentProfilePath,
    write: state.write,
    ...(state.documentId === undefined ? {} : { documentId: state.documentId }),
    ...(state.documentOwner === undefined
      ? {}
      : { documentOwner: state.documentOwner }),
    ...(state.documentStatus === undefined
      ? {}
      : { documentStatus: state.documentStatus }),
    ...(state.documentType === undefined
      ? {}
      : { documentType: state.documentType }),
    ...(state.baseRef === undefined ? {} : { baseRef: state.baseRef }),
    ...(state.bufExecutablePath === undefined
      ? {}
      : { bufExecutablePath: state.bufExecutablePath })
  });
}
