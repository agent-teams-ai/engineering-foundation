import { FoundationError } from "../foundation-error.js";

type UnexpectedFailureCauseKind =
  | "filesystem"
  | "parser"
  | "process"
  | "contract"
  | "internal-invariant"
  | "unknown";

export interface UnexpectedFailureProblem {
  readonly code:
    | "UNEXPECTED_CONTRACT_FAILURE"
    | "UNEXPECTED_FAILURE"
    | "UNEXPECTED_FILESYSTEM_FAILURE"
    | "UNEXPECTED_INTERNAL_INVARIANT_FAILURE"
    | "UNEXPECTED_PARSER_FAILURE"
    | "UNEXPECTED_PROCESS_FAILURE";
  readonly message: string;
  readonly phase: string;
  readonly retryable: false;
}

const FILESYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EBADF",
  "EBUSY",
  "EEXIST",
  "EFBIG",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS"
]);

const CONTRACT_ERROR_CODES = new Set([
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_OUT_OF_RANGE"
]);

function stableStringProperty(error: unknown, property: "code" | "name"): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  try {
    const value = (error as Record<"code" | "name", unknown>)[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessCancellationFailure(error: unknown): boolean {
  return stableStringProperty(error, "name") === "ProcessCancellationError";
}

function safeInstanceOf<T>(error: unknown, constructor: new (...args: never[]) => T): error is T {
  try {
    return error instanceof constructor;
  } catch {
    return false;
  }
}

function isParserFailure(error: unknown, name: string | undefined): boolean {
  return (
    safeInstanceOf(error, SyntaxError) ||
    name === "StrictJsonError" ||
    name === "JSONParseError" ||
    name === "YAMLParseError"
  );
}

function isProcessFailure(
  error: unknown,
  code: string | undefined,
  name: string | undefined
): boolean {
  return (
    (safeInstanceOf(error, FoundationError) && code === "PROCESS_FAILED") ||
    name === "PackageScriptTimeoutError" ||
    name === "ProcessCancellationError" ||
    code?.startsWith("ERR_CHILD_PROCESS_") === true
  );
}

function causeKind(error: unknown): UnexpectedFailureCauseKind {
  const code = stableStringProperty(error, "code");
  const name = stableStringProperty(error, "name");

  if (name === "ContainedFileReadError" || FILESYSTEM_ERROR_CODES.has(code ?? "")) {
    return "filesystem";
  }
  if (isParserFailure(error, name)) {
    return "parser";
  }
  if (isProcessFailure(error, code, name)) {
    return "process";
  }
  if (name === "CapabilityInputError" || safeInstanceOf(error, TypeError) || CONTRACT_ERROR_CODES.has(code ?? "")) {
    return "contract";
  }
  if (name === "AssertionError" || name === "InternalInvariantError" || code === "ERR_ASSERTION") {
    return "internal-invariant";
  }
  return "unknown";
}

const SAFE_MESSAGES: Readonly<Record<UnexpectedFailureCauseKind, string>> = {
  filesystem: "An unexpected filesystem failure occurred.",
  parser: "An unexpected parser failure occurred.",
  process: "An unexpected process failure occurred.",
  contract: "An unexpected contract failure occurred.",
  "internal-invariant": "An internal invariant failed unexpectedly.",
  unknown: "An unexpected failure occurred."
};

const STABLE_CODES: Readonly<Record<UnexpectedFailureCauseKind, UnexpectedFailureProblem["code"]>> = {
  contract: "UNEXPECTED_CONTRACT_FAILURE",
  filesystem: "UNEXPECTED_FILESYSTEM_FAILURE",
  "internal-invariant": "UNEXPECTED_INTERNAL_INVARIANT_FAILURE",
  parser: "UNEXPECTED_PARSER_FAILURE",
  process: "UNEXPECTED_PROCESS_FAILURE",
  unknown: "UNEXPECTED_FAILURE"
};

export function classifyUnexpectedFailure(
  error: unknown,
  phase: string
): UnexpectedFailureProblem {
  const kind = causeKind(error);
  return Object.freeze({
    code: STABLE_CODES[kind],
    message: SAFE_MESSAGES[kind],
    phase,
    retryable: false
  });
}
