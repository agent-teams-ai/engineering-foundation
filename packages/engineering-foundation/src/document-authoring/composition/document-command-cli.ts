export {
  documentMutationFailure,
} from "../adapters/inbound/cli/document-command-failure.js";
export {
  renderDocumentCommandJson,
  renderDocumentCommandText,
} from "../adapters/inbound/cli/document-command-renderer.js";
export { createNodeDocumentCommands } from "./node-document-commands.js";

import type { DocumentCommandId } from "../application/model/document-command.js";
import { documentMutationFailure } from "../adapters/inbound/cli/document-command-failure.js";
import { documentFindFailure } from "../find-command.js";

export function projectDocumentLaunchFailure(
  rawArguments: readonly string[],
  error: unknown
): { readonly exitCode: number; readonly stdout: string } | undefined {
  if (rawArguments[0] !== "docs") {
    return undefined;
  }
  const json = rawArguments.includes("--json") || rawArguments.some(
    (argument, index) =>
      argument === "--format" && rawArguments[index + 1] === "json"
  );
  if (!json) {
    return undefined;
  }
  if (rawArguments[1] === "find") {
    const result = documentFindFailure(error);
    return {
      exitCode: result.exitCode,
      stdout: `${JSON.stringify(result.envelope)}\n`
    };
  }
  const requested = `docs.${rawArguments[1] ?? ""}`;
  const command: DocumentCommandId =
    requested === "docs.new" ||
    requested === "docs.doctor" ||
    requested === "docs.recover"
      ? requested
      : "docs.doctor";
  const result = documentMutationFailure(command, error);
  return {
    exitCode: result.exitCode,
    stdout: `${JSON.stringify(result.envelope)}\n`
  };
}
