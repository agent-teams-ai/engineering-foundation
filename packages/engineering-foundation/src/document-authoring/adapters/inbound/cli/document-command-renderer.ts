import type {
  DocumentCommandExecution,
  DocumentDoctorResult,
  DocumentNewResult,
  DocumentRecoverResult,
  DocumentRecoveryCommand
} from "../../../application/model/document-command.js";

type DocumentMutationResult =
  | DocumentDoctorResult
  | DocumentNewResult
  | DocumentRecoverResult;

export function renderDocumentCommandJson(
  execution: DocumentCommandExecution<DocumentMutationResult>
): string {
  return `${JSON.stringify(execution.envelope)}\n`;
}

function humanCommand(command: DocumentRecoveryCommand): string {
  const exactVersion = command.args["exactFoundationVersion"];
  const prefix = exactVersion === undefined
    ? "agent-teams-foundation"
    : `pnpm dlx @agent-teams/engineering-foundation@${exactVersion}`;
  switch (command.commandId) {
    case "docs.recover": return `${prefix} docs recover`;
    case "scaffold-recover": return `${prefix} scaffold-recover`;
    case "detach": return `${prefix} detach`;
  }
}

function renderNew(result: DocumentNewResult, lines: string[]): void {
  if (result.documentPath !== undefined) {
    lines.push(`Document: ${result.documentPath}`);
  }
  if (result.writeState !== undefined) {
    lines.push(`Write: ${result.writeState}`);
  }
  if (result.reachability?.state === "manual-required") {
    lines.push(`Reachability: update ${String(result.reachability.indexPath)}`);
    lines.push(`Link: ${String(result.reachability.markdownLink)}`);
  }
  if (result.writeState === "preview") {
    lines.push("Next: review this preview, then run docs new without --dry-run");
  } else if (result.reachability?.state === "manual-required") {
    lines.push(`Next: add the exact link to ${String(result.reachability.indexPath)}`);
  } else if (
    result.writeState === "applied" ||
    result.writeState === "already-applied"
  ) {
    lines.push("Next: agent-teams-foundation repo check");
  }
}

function renderDoctor(result: DocumentDoctorResult, lines: string[]): void {
  if (result.installedFoundationVersion !== undefined) {
    lines.push(`Installed Foundation: ${result.installedFoundationVersion}`);
  }
  if (result.installedFoundationBuildIdentity !== undefined) {
    lines.push(`Installed build: ${result.installedFoundationBuildIdentity}`);
  }
  if (result.filesystem !== undefined) {
    lines.push(
      `Filesystem durability: ${result.filesystem.strictDirectoryDurability} (${result.filesystem.basis})`
    );
  }
  lines.push(`Transaction: ${result.transactionState}`);
  if (result.protocolKind !== undefined) {
    lines.push(`Transaction protocol: ${result.protocolKind}`);
  }
  if (result.foundationVersion !== undefined) {
    lines.push(`Journal Foundation: ${result.foundationVersion}`);
  }
  if (result.foundationBuildIdentity !== undefined) {
    lines.push(`Journal build: ${result.foundationBuildIdentity}`);
  }
  lines.push(`Recovery: ${result.recoveryClass}`);
  if (result.recoveryCommand !== undefined) {
    lines.push(`Run: ${humanCommand(result.recoveryCommand)}`);
    const exactBuild = result.recoveryCommand.args["exactFoundationBuildIdentity"];
    if (exactBuild !== undefined) {
      lines.push(`Required build: ${exactBuild}`);
    }
  }
}

function renderRecover(result: DocumentRecoverResult, lines: string[]): void {
  lines.push(`Transaction: ${result.transactionState}`);
  lines.push(`Write: ${result.writeState}`);
  if (result.recoveryCommand !== undefined) {
    lines.push(`Run: ${humanCommand(result.recoveryCommand)}`);
    const exactBuild = result.recoveryCommand.args["exactFoundationBuildIdentity"];
    if (exactBuild !== undefined) {
      lines.push(`Required build: ${exactBuild}`);
    }
  }
}

export function renderDocumentCommandText(
  execution: DocumentCommandExecution<DocumentMutationResult>
): string {
  const { envelope } = execution;
  const lines = [`${envelope.command}: ${envelope.outcome}`];
  switch (envelope.result.kind) {
    case "new": renderNew(envelope.result, lines); break;
    case "doctor": renderDoctor(envelope.result, lines); break;
    case "recover": renderRecover(envelope.result, lines); break;
  }
  for (const entry of envelope.diagnostics) {
    lines.push(
      `${entry.severity.toUpperCase()} ${entry.ruleId} ${entry.subject}: ${entry.message}`
    );
  }
  return `${lines.join("\n")}\n`;
}
