import { type DocsExecutionV2, type DocsExecutionV3 } from "../../contracts/command.js";
import { assertDocsCommandEnvelopeSchema } from "../outbound/docs-command-envelope-schema-validator.js";
import { DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION, type DocsCommandOutcome, type DocsDiagnostic, type DocsCommandV2, type DocsCommandV3, DocsProfileError } from "../../application/command-operations.js";
import { CliInputError } from "./cli-input.js";
export type DocsMachineExecution = DocsExecutionV2<unknown> | DocsExecutionV3<unknown>;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isInputError(error: unknown, code: string | undefined): boolean {
  return error instanceof CliInputError || error instanceof DocsProfileError ||
    (code !== undefined && /^DOCUMENT_[A-Z_]+_INPUT_INVALID$/u.test(code)) ||
    (error instanceof Error && error.name === "InvalidDocumentAuthoringProfileError");
}

function isAuthorityInputError(error: unknown, code: string | undefined): boolean {
  return code?.startsWith("DOCUMENT_") === true ||
    (error instanceof Error && (
      error.name === "InvalidDocumentAuthoringProfileError" ||
      /document authoring profile|Foundation authoring profile/u.test(error.message)
    ));
}

type MachineFailureKind = "authority" | "cancelled" | "filesystem" | "internal" | "process" | "validation";

function machineFailureKind(error: unknown, cancelled: boolean, inputInvalid: boolean, authorityInvalid: boolean): MachineFailureKind {
  if (cancelled) {return "cancelled";}
  if (authorityInvalid) {return "authority";}
  if (inputInvalid || error instanceof SyntaxError || error instanceof TypeError) {return "validation";}
  const code = errorCode(error);
  if (code?.startsWith("PROCESS_") === true || (error instanceof Error && /process|spawn/u.test(error.name))) {return "process";}
  if (code !== undefined && /^(?:EACCES|EEXIST|EISDIR|ELOOP|EMFILE|ENAMETOOLONG|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/u.test(code)) {return "filesystem";}
  return "internal";
}

function machineErrorMessage(outcome: "cancelled" | "execution-failure" | "invalid-input", authorityInvalid: boolean): string {
  if (outcome === "cancelled") {return "Documentation command was cancelled.";}
  if (outcome === "invalid-input") {
    return authorityInvalid ? "Documentation authority is invalid." : "Documentation command input is invalid.";
  }
  return "Documentation command failed.";
}

export function commandEnvelopeVersion(command: DocsCommandV3): 2 | 3 {
  return command === "docs.context" || command === "docs.init" ? 3 : 2;
}

export function docsCliErrorExecution(
  command: DocsCommandV3,
  error: unknown,
  machine: boolean,
  envelopeVersion: 2 | 3 = commandEnvelopeVersion(command)
): DocsMachineExecution {
  const code = errorCode(error);
  const cancelled = error instanceof Error && error.name === "AbortError";
  const inputInvalid = isInputError(error, code);
  const outcome = cancelled ? "cancelled" as const : inputInvalid ? "invalid-input" as const : "execution-failure" as const;
  const authorityInvalid = inputInvalid && isAuthorityInputError(error, code);
  const phase = cancelled ? "apply" as const : authorityInvalid ? "authority" as const : inputInvalid ? "input" as const : "apply" as const;
  const baseRuleId = cancelled ? "docs.cli.cancelled" : inputInvalid ? "docs.cli.invalid-input" : "docs.cli.execution-failure";
  const failureKind = machineFailureKind(error, cancelled, inputInvalid, authorityInvalid);
  const envelopeBase = {
    protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
    command,
    outcome,
    diagnostics: [{
      ruleId: machine ? `${baseRuleId}.${failureKind}` : baseRuleId,
      severity: "error" as const,
      phase,
      subject: command,
      message: machine
        ? machineErrorMessage(outcome, authorityInvalid)
        : error instanceof Error ? error.message : "Unknown command failure."
    }],
    result: Object.freeze({})
  };
  return {
    exitCode: cancelled ? 130 : inputInvalid ? 2 : 3,
    envelope: envelopeVersion === 3
      ? { ...envelopeBase, schemaVersion: 3 }
      : { ...envelopeBase, command: command as DocsCommandV2, schemaVersion: 2 }
  } as DocsMachineExecution;
}

export function directExecution(
  command: DocsCommandV3,
  outcome: DocsCommandOutcome,
  result: unknown,
  diagnostics: readonly DocsDiagnostic[] = []
): DocsExecutionV3<unknown> {
  const exitCode = outcome === "success" ? 0
    : outcome === "invalid-input" ? 2
      : outcome === "execution-failure" ? 3
        : outcome === "cancelled" ? 130
          : 1;
  return Object.freeze({
    exitCode,
    envelope: Object.freeze({
      schemaVersion: 3 as const,
      protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }),
      command,
      outcome,
      diagnostics: Object.freeze([...diagnostics]),
      result
    })
  });
}

export async function validatedMachineExecution(
  id: DocsCommandV3,
  execution: DocsMachineExecution
): Promise<DocsMachineExecution> {
  try {
    await assertDocsCommandEnvelopeSchema(execution.envelope);
    return execution;
  } catch {
    const schemaVersion = execution.envelope.schemaVersion === 3
      ? 3
      : commandEnvelopeVersion(id);
    const fallback = {
      exitCode: 3,
      envelope: {
        schemaVersion,
        protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
        command: id,
        outcome: "execution-failure",
        diagnostics: [{
          ruleId: "docs.cli.invalid-output.internal",
          severity: "error",
          phase: "apply",
          subject: id,
          message: "Documentation command produced invalid output."
        }],
        result: Object.freeze({})
      }
    } as DocsMachineExecution;
    await assertDocsCommandEnvelopeSchema(fallback.envelope);
    return fallback;
  }
}
