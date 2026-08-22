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
  readonly documentDestination?: string;
  readonly documentDryRun: boolean;
  readonly documentOwner?: string;
  readonly documentProfilePath: string;
  readonly documentRelated: readonly string[];
  readonly documentSlug?: string;
  readonly documentStatus?: string;
  readonly documentSummary?: string;
  readonly documentTitle?: string;
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
  "agent-workflow": 2,
  "architecture-decisions-promote-baseline": 0,
  attach: 1,
  check: 1,
  detach: 0,
  "docs.find": 1,
  "docs.doctor": 0,
  "docs.new": 0,
  "docs.recover": 0,
  explain: 1,
  "gate.run": 1,
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
  documentDestination?: string;
  documentDryRun: boolean;
  documentOwner?: string;
  documentProfilePath: string;
  documentProfilePathProvided: boolean;
  readonly documentRelated: string[];
  documentSlug?: string;
  documentStatus?: string;
  documentSummary?: string;
  documentTitle?: string;
  documentType?: string;
  readonly providedOptions: Set<string>;
  baseRef?: string;
  bufExecutablePath?: string;
  write: boolean;
  optionsEnded: boolean;
}

const DEFAULT_DOCUMENT_AUTHORING_PROFILE_PATH =
  "architecture/foundation/document-authoring.yaml";
const MAXIMUM_RELATED_DOCUMENTS = 128;
const MAXIMUM_CONSUMER_ROOT_BYTES = 512;

function requiredOptionValue(
  args: readonly string[],
  index: number,
  option: string
): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.startsWith("-")
  ) {
    throw new FoundationError("CONSUMER_INVALID", `${option} requires a value.`);
  }
  return candidate;
}

function requiredBaseRefValue(
  args: readonly string[],
  index: number
): string {
  const candidate = args[index + 1];
  if (candidate === undefined || candidate.length === 0) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--base requires a Git ref."
    );
  }
  if (candidate.startsWith("-")) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "The base ref cannot start with a dash."
    );
  }
  return candidate;
}

function provideScalarOption(
  state: ArgumentState,
  identity: string,
  displayName: string
): void {
  if (state.providedOptions.has(identity)) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${displayName} may be specified only once.`
    );
  }
  state.providedOptions.add(identity);
}

function documentOptionValue(
  args: readonly string[],
  index: number,
  state: ArgumentState
): string {
  const option = args[index] ?? "Document option";
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.startsWith("-")
  ) {
    throw new FoundationError("CONSUMER_INVALID", `${option} requires a value.`);
  }
  if (candidate.length > 1_024) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${option} exceeds the maximum supported length.`
    );
  }
  if (option !== "--related" && state.providedOptions.has(option)) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${option} may be specified only once.`
    );
  }
  state.providedOptions.add(option);
  return candidate;
}

function consumeDocumentOption(
  args: readonly string[],
  index: number,
  state: ArgumentState
): number | undefined {
  const value = args[index];
  const field = value === "--id"
    ? "documentId"
    : value === "--destination"
      ? "documentDestination"
    : value === "--owner"
      ? "documentOwner"
      : value === "--profile"
        ? "documentProfilePath"
        : value === "--status"
          ? "documentStatus"
          : value === "--slug"
            ? "documentSlug"
            : value === "--summary"
              ? "documentSummary"
              : value === "--title"
                ? "documentTitle"
          : value === "--type"
            ? "documentType"
            : undefined;
  if (value === "--related") {
    if (state.documentRelated.length >= MAXIMUM_RELATED_DOCUMENTS) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `--related accepts at most ${MAXIMUM_RELATED_DOCUMENTS} values.`
      );
    }
    state.documentRelated.push(documentOptionValue(args, index, state));
    return 1;
  }
  if (field === undefined) {
    return undefined;
  }
  const candidate = documentOptionValue(args, index, state);
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
  const candidate = requiredOptionValue(args, index, "--buf-executable");
  state.bufExecutablePath = candidate;
  return 1;
}

function consumeDocumentBooleanOption(
  value: string,
  state: ArgumentState
): boolean {
  if (value !== "--dry-run") {
    return false;
  }
  if (state.providedOptions.has(value)) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--dry-run may be specified only once."
    );
  }
  state.providedOptions.add(value);
  state.documentDryRun = true;
  return true;
}

function consumePositionalControl(
  value: string,
  state: ArgumentState
): boolean {
  if (!state.optionsEnded && value === "--") {
    state.optionsEnded = true;
    return true;
  }
  if (state.optionsEnded) {
    state.positional.push(value);
    return true;
  }
  return false;
}

function consumeOutputFormatOption(
  args: readonly string[],
  index: number,
  state: ArgumentState
): number | undefined {
  const value = args[index];
  if (value === "--json") {
    provideScalarOption(state, "output-format", "--json or --format");
    state.format = "json";
    return 0;
  }
  if (value !== "--format") {
    return undefined;
  }
  const candidate = args[index + 1];
  if (candidate !== "json" && candidate !== "text") {
    throw new FoundationError("CONSUMER_INVALID", "--format requires json or text.");
  }
  provideScalarOption(state, "output-format", "--json or --format");
  state.format = candidate;
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
  if (consumePositionalControl(value, state)) {
    return 0;
  }
  const outputFormatOption = consumeOutputFormatOption(args, index, state);
  if (outputFormatOption !== undefined) {
    return outputFormatOption;
  }
  if (consumeDocumentBooleanOption(value, state)) {
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
    const candidate = requiredOptionValue(args, index, "--consumer");
    provideScalarOption(state, "--consumer", "--consumer");
    const consumerRoot = resolve(candidate);
    if (Buffer.byteLength(consumerRoot, "utf8") > MAXIMUM_CONSUMER_ROOT_BYTES) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `--consumer resolves beyond ${MAXIMUM_CONSUMER_ROOT_BYTES} UTF-8 bytes.`
      );
    }
    state.consumerRoot = consumerRoot;
    return 1;
  }
  if (value === "--base") {
    const candidate = requiredBaseRefValue(args, index);
    state.baseRef = candidate;
    return 1;
  }
  if (value === "--config") {
    const candidate = requiredOptionValue(args, index, "--config");
    state.configPath = candidate;
    state.configPathProvided = true;
    return 1;
  }
  if (value.startsWith("-")) {
    throw new FoundationError("CONSUMER_INVALID", `Unknown option: ${value}.`);
  }
  state.positional.push(value);
  return 0;
}

function validateCommandOptions(command: string, state: ArgumentState): void {
  validateDocumentCommandOptions(command, state);
  validateNonDocumentCommandOptions(command, state);
}

function validateDocumentCommandOptions(
  command: string,
  state: ArgumentState
): void {
  const findOnly = state.documentStatus !== undefined;
  if (findOnly && command !== "docs.find") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--status is supported only by docs find."
    );
  }
  const sharedDocumentOptions =
    state.documentId !== undefined ||
    state.documentOwner !== undefined ||
    state.documentProfilePathProvided ||
    state.documentType !== undefined;
  if (sharedDocumentOptions && command !== "docs.find" && command !== "docs.new") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--id, --owner, --profile, and --type are supported only by docs find or docs new."
    );
  }
  const newOnly =
    state.documentDestination !== undefined ||
    state.documentDryRun ||
    state.documentRelated.length > 0 ||
    state.documentSlug !== undefined ||
    state.documentSummary !== undefined ||
    state.documentTitle !== undefined;
  if (newOnly && command !== "docs.new") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--destination, --dry-run, --related, --slug, --summary, and --title are supported only by docs new."
    );
  }
  if (command === "docs.new") {
    const missing = [
      ["--type", state.documentType],
      ["--id", state.documentId],
      ["--title", state.documentTitle],
      ["--owner", state.documentOwner],
      ["--summary", state.documentSummary]
    ].filter(([, value]) => value === undefined).map(([option]) => option);
    if (missing.length > 0) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `docs new requires ${missing.join(", ")}.`
      );
    }
  }
}

function validateNonDocumentCommandOptions(
  command: string,
  state: ArgumentState
): void {
  if (
    state.baseRef !== undefined &&
    (command !== "agent-workflow" || state.positional[0] !== "changed")
  ) {
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
    documentDryRun: false,
    documentRelated: [],
    format: "text",
    providedOptions: new Set<string>(),
    write: false,
    optionsEnded: false
  };

  const command = commandFromArguments(args);
  const firstArgumentIndex = args[0] === "docs" || args[0] === "gate" ||
    (args[0] === "repo" && args[1] === "check") ? 2 : 1;
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
    documentDryRun: state.documentDryRun,
    documentRelated: Object.freeze([...state.documentRelated]),
    write: state.write,
    ...(state.documentId === undefined ? {} : { documentId: state.documentId }),
    ...(state.documentDestination === undefined
      ? {}
      : { documentDestination: state.documentDestination }),
    ...(state.documentOwner === undefined
      ? {}
      : { documentOwner: state.documentOwner }),
    ...(state.documentStatus === undefined
      ? {}
      : { documentStatus: state.documentStatus }),
    ...(state.documentSlug === undefined ? {} : { documentSlug: state.documentSlug }),
    ...(state.documentSummary === undefined
      ? {}
      : { documentSummary: state.documentSummary }),
    ...(state.documentTitle === undefined
      ? {}
      : { documentTitle: state.documentTitle }),
    ...(state.documentType === undefined
      ? {}
      : { documentType: state.documentType }),
    ...(state.baseRef === undefined ? {} : { baseRef: state.baseRef }),
    ...(state.bufExecutablePath === undefined
      ? {}
      : { bufExecutablePath: state.bufExecutablePath })
  });
}

function commandFromArguments(args: readonly string[]): string {
  if (args[0] === "docs" || args[0] === "gate") {
    return `${args[0]}.${args[1] ?? ""}`;
  }
  if (args[0] === "repo" && args[1] === "check") {
    return "check";
  }
  return args[0] ?? "help";
}
