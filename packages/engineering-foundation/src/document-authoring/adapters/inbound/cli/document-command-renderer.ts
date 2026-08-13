import type {
  DocumentCommandExecution,
  DocumentCommandRemediation,
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

function humanRemediationCommand(command: DocumentCommandRemediation): string {
  if (
    command.commandId === "detach" ||
    command.commandId === "docs.recover" ||
    command.commandId === "scaffold-recover"
  ) {
    return humanCommand({ commandId: command.commandId, args: command.args });
  }
  switch (command.commandId) {
    case "docs.doctor": return "agent-teams-foundation docs doctor";
    case "docs.find": return "agent-teams-foundation docs find";
    case "docs.new": return "agent-teams-foundation docs new";
  }
}

function renderRemediationCommand(
  command: DocumentCommandRemediation,
  lines: string[],
  rendered: Set<string>
): void {
  const identity = JSON.stringify(command);
  if (rendered.has(identity)) {
    return;
  }
  rendered.add(identity);
  lines.push(`Run: ${humanRemediationCommand(command)}`);
  const consumerRoot = command.args["consumerRoot"];
  if (consumerRoot !== undefined) {
    lines.push(`Run from consumer root: ${consumerRoot}`);
  }
  const text = command.args["text"];
  if (text !== undefined) {
    lines.push(`Query: ${text}`);
  }
  const exactBuild = command.args["exactFoundationBuildIdentity"];
  if (exactBuild !== undefined) {
    lines.push(`Required build: ${exactBuild}`);
  }
}

function renderRecoveryCommand(
  command: DocumentRecoveryCommand,
  lines: string[],
  rendered: Set<string>
): void {
  renderRemediationCommand(command, lines, rendered);
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

function renderDoctor(
  result: DocumentDoctorResult,
  lines: string[],
  rendered: Set<string>
): void {
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
    renderRecoveryCommand(result.recoveryCommand, lines, rendered);
  }
}

function renderRecover(
  result: DocumentRecoverResult,
  lines: string[],
  rendered: Set<string>
): void {
  lines.push(`Transaction: ${result.transactionState}`);
  lines.push(`Write: ${result.writeState}`);
  if (result.recoveryCommand !== undefined) {
    renderRecoveryCommand(result.recoveryCommand, lines, rendered);
  }
}

export function renderDocumentCommandText(
  execution: DocumentCommandExecution<DocumentMutationResult>
): string {
  const { envelope } = execution;
  const lines = [`${envelope.command}: ${envelope.outcome}`];
  const renderedRemediations = new Set<string>();
  switch (envelope.result.kind) {
    case "new": renderNew(envelope.result, lines); break;
    case "doctor": renderDoctor(envelope.result, lines, renderedRemediations); break;
    case "recover": renderRecover(envelope.result, lines, renderedRemediations); break;
  }
  for (const entry of envelope.diagnostics) {
    lines.push(
      `${entry.severity.toUpperCase()} ${entry.ruleId} ${entry.subject}: ${entry.message}`
    );
    if (entry.remediation !== undefined) {
      renderRemediationCommand(entry.remediation, lines, renderedRemediations);
    }
  }
  return `${lines.join("\n")}\n`;
}
