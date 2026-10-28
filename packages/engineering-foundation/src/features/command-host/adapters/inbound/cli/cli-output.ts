import type {
  CommandModeStatus,
  CommandDevOnlyStatus,
} from "../../../application/command-services.js";

export function printStatus(status: CommandModeStatus, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Foundation mode: ${status.mode}\n`);
  process.stdout.write(`Consumer: ${status.consumerRoot}\n`);
  if (status.dependencySpec !== undefined) {
    process.stdout.write(`Declared version: ${status.dependencySpec}\n`);
  }
  if (status.installedVersion !== undefined) {
    process.stdout.write(`Installed version: ${status.installedVersion}\n`);
  }
  if (status.installedPackageRoot !== undefined) {
    process.stdout.write(`Installed path: ${status.installedPackageRoot}\n`);
  }
  if (status.lockfilePath !== undefined) {
    process.stdout.write(`Lockfile: ${status.lockfilePath}\n`);
  }
  if (status.lockfilePackageKey !== undefined) {
    process.stdout.write(`Locked package: ${status.lockfilePackageKey}\n`);
  }
  if (status.linkState !== undefined) {
    process.stdout.write(`Attached commit: ${status.linkState.gitCommit}\n`);
    process.stdout.write(`Attached dirty: ${status.linkState.gitDirty ? "yes" : "no"}\n`);
  }
  if (status.sourceGitCommit !== undefined) {
    process.stdout.write(`Current commit: ${status.sourceGitCommit}\n`);
  }
  if (status.sourceGitDirty !== undefined) {
    process.stdout.write(`Current dirty: ${status.sourceGitDirty ? "yes" : "no"}\n`);
  }
  const transaction = "transaction" in status ? status.transaction : undefined;
  if (transaction !== undefined && transaction.state !== "idle") {
    process.stdout.write(`Transaction: ${transaction.state}\n`);
    if (transaction.state === "pending") {
      process.stdout.write(`Transaction kind: ${transaction.operationKind}\n`);
      if (transaction.recovery.commandId === "detach") {
        process.stdout.write("Recovery: detach with the installed Foundation.\n");
      } else {
        const buildIdentity = transaction.recovery.exactFoundationBuildIdentity;
        process.stdout.write(
          `Recovery: ${transaction.recovery.commandId} with Foundation ${transaction.recovery.exactFoundationVersion}${buildIdentity === undefined ? "" : ` (${buildIdentity})`}\n`,
        );
      }
    }
  }
  for (const issue of status.issues) {
    process.stdout.write(`Issue: ${issue}\n`);
  }
}

export function printDevOnlyStatus(status: CommandDevOnlyStatus, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  process.stdout.write("Foundation dependency policy: DEV_ONLY\n");
  process.stdout.write(`Consumer: ${status.consumerRoot}\n`);
  if (status.dependencySpec !== undefined) {
    process.stdout.write(`Declared version: ${status.dependencySpec}\n`);
  }
}

export function printHelp(): void {
  process.stdout.write(`Usage:
  agent-teams-foundation check [capability] [--consumer <path>] [--format text|json]
  agent-teams-foundation repo check [capability] [--consumer <path>] [--format text|json]
  agent-teams-foundation agent-workflow changed [--base <ref>] [--consumer <path>] [--format text|json]
  agent-teams-foundation agent-workflow check-changed [--base <ref>] [--consumer <path>] [--format text|json]
  agent-teams-foundation agent-workflow instructions <repository-file> [--consumer <path>] [--format text|json]
  agent-teams-foundation gate run <profile> [--consumer <path>] [--format text|json]
  agent-teams-foundation quality check [--scope-only] [--consumer <path>] [--format text|json]
  agent-teams-foundation quality format [--scope-only] [--consumer <path>] [--format text|json]
  agent-teams-foundation baseline check|init|prune --config <findings-baseline.yaml> [--consumer <path>] [--format text|json]
  agent-teams-foundation explain <rule-id> [--format text|json]
  agent-teams-foundation architecture-decisions-promote-baseline [--consumer <path>] [--json]
  agent-teams-foundation public-api-audit --consumer <path> --config <request.json> --format json
  agent-teams-foundation public-api-promote-release [--consumer <path>] [--native-transition <request.json> [--qualification-only]] [--json]
  agent-teams-foundation protobuf-qualify-breaking --buf-executable <absolute-path> [--consumer <path>] [--write] [--json]
  agent-teams-foundation scaffold-plan <intent-path> [--consumer <path>] [--config <path>] [--json]
  agent-teams-foundation scaffold-apply <plan-path> [--consumer <path>] [--json]
  agent-teams-foundation scaffold-recover [--consumer <path>] [--json]
  agent-teams-foundation schema <schema-id>
  agent-teams-foundation attach <path> [--consumer <path>]
  agent-teams-foundation status [--consumer <path>] [--json]
  agent-teams-foundation detach [--consumer <path>] [--json]
  agent-teams-foundation assert-dev-only [--consumer <path>] [--json]
  agent-teams-foundation assert-registry [--consumer <path>] [--json]
  agent-teams-foundation self-check [--json]
  agent-teams-foundation version
`);
}
