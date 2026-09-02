#!/usr/bin/env node

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CapabilityInputError, exitCodeForOutcome } from "./capability-runtime.js";
import { promoteArchitectureDecisionBaseline } from "./capabilities/governance-architecture-decisions/module.js";
import { promotePublicApiRelease } from "./capabilities/public-api-compatibility/module.js";
import { runAgentWorkflowChangedCommand } from "./capabilities/repository-agent-workflow/changed-command.js";
import { runAgentWorkflowInstructionsCommand } from "./capabilities/repository-agent-workflow/instructions-command.js";
import { runFoundationCheck } from "./check-runner.js";
import { parseArguments, type ParsedArguments } from "./cli-arguments.js";
import { foundationCommandFailure } from "./command-error.js";
import { RULE_REGISTRY } from "./composition/rule-registry.js";
import { FoundationError } from "./errors.js";
import { ProcessCancellationError } from "./process-execution/node-process-runner.js";
import { loadFoundationConfig } from "./foundation-config.js";
import { systemNow } from "./local-mode/adapters/outbound/time/system-clock.js";
import { createNodeProcessRunner } from "./local-mode/process-runner.js";
import { FoundationLocalModeService } from "./local-mode/service.js";
import type {
  FoundationDevOnlyStatus,
  FoundationStatus,
  FoundationTransactionAwareStatus
} from "./local-mode/types.js";
import { inspectFoundationPackage } from "./package-self-check.js";
import { installedFoundationVersion } from "./package-version.js";
import { tryRunQualityGateCliCommand } from "./quality-gate-cli-command.js";
import { renderFoundationReportText } from "./report-renderer.js";
import { runScaffoldingCliCommand } from "./scaffolding/cli-command.js";
import { ScaffoldError } from "./scaffolding/scaffold-error.js";
import { FoundationTransactionError } from "./transaction-coordination/application/foundation-transaction-error.js";
import {
  isFoundationSchemaId,
  readFoundationSchema
} from "./schema-catalog.js";

function printStatus(
  status: FoundationStatus | FoundationTransactionAwareStatus,
  json: boolean
): void {
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
    process.stdout.write(
      `Attached dirty: ${status.linkState.gitDirty ? "yes" : "no"}\n`
    );
  }
  if (status.sourceGitCommit !== undefined) {
    process.stdout.write(`Current commit: ${status.sourceGitCommit}\n`);
  }
  if (status.sourceGitDirty !== undefined) {
    process.stdout.write(
      `Current dirty: ${status.sourceGitDirty ? "yes" : "no"}\n`
    );
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
          `Recovery: ${transaction.recovery.commandId} with Foundation ${transaction.recovery.exactFoundationVersion}${buildIdentity === undefined ? "" : ` (${buildIdentity})`}\n`
        );
      }
    }
  }
  for (const issue of status.issues) {
    process.stdout.write(`Issue: ${issue}\n`);
  }
}

function printDevOnlyStatus(
  status: FoundationDevOnlyStatus,
  json: boolean
): void {
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

function printHelp(): void {
  process.stdout.write(`Usage:
  agent-teams-foundation check [capability] [--consumer <path>] [--format text|json]
  agent-teams-foundation repo check [capability] [--consumer <path>] [--format text|json]
  agent-teams-foundation agent-workflow changed [--base <ref>] [--consumer <path>] [--format text|json]
  agent-teams-foundation agent-workflow instructions <repository-file> [--consumer <path>] [--format text|json]
  agent-teams-foundation gate run <profile> [--consumer <path>] [--format text|json]
  agent-teams-foundation explain <rule-id> [--format text|json]
  agent-teams-foundation architecture-decisions-promote-baseline [--consumer <path>] [--json]
  agent-teams-foundation public-api-promote-release [--consumer <path>] [--json]
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

async function runLocalModeCommand(
  parsed: ParsedArguments,
  service: FoundationLocalModeService,
  json: boolean
): Promise<boolean> {
  switch (parsed.command) {
    case "attach": {
      const target = parsed.positional[0];
      if (target === undefined) {
        throw new FoundationError(
          "CONSUMER_INVALID",
          "attach requires a foundation repository or package path."
        );
      }
      const result = await service.attach(parsed.consumerRoot, target);
      printStatus(result.status, json);
      return true;
    }
    case "assert-dev-only": {
      printDevOnlyStatus(
        await service.assertDevOnly(parsed.consumerRoot),
        json
      );
      return true;
    }
    case "assert-registry": {
      printStatus(
        await service.assertRegistry(parsed.consumerRoot),
        json
      );
      return true;
    }
    case "architecture-decisions-promote-baseline": {
      const settings = await loadFoundationConfig(parsed.consumerRoot);
      const declaration = settings.declaredCapabilities.find(
        ({ id }) => id === "governance.architecture-decisions"
      );
      if (declaration === undefined) {
        throw new FoundationError(
          "CONSUMER_INVALID",
          "governance.architecture-decisions must be declared before baseline promotion."
        );
      }
      const promotion = await promoteArchitectureDecisionBaseline({
        consumerRoot: parsed.consumerRoot,
        configPath: declaration.configPath
      });
      process.stdout.write(
        json
          ? `${JSON.stringify({ promotion }, null, 2)}\n`
          : `Architecture-decision baseline ${promotion.writeResult}.\n`
      );
      return true;
    }
    case "detach": {
      printStatus(await service.detach(parsed.consumerRoot), json);
      return true;
    }
    case "status": {
      const status = await service.status(parsed.consumerRoot);
      printStatus(status, json);
      if (status.mode === "INVALID") {
        process.exitCode = 1;
      }
      return true;
    }
    default:
      return false;
  }
}

async function runCheckCommand(
  parsed: ParsedArguments,
  json: boolean
): Promise<boolean> {
  if (parsed.command !== "check") {
    return false;
  }
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  try {
    const report = await runFoundationCheck({
      consumerRoot: parsed.consumerRoot,
      foundationVersion: await installedFoundationVersion(),
      ...(parsed.positional[0] === undefined
        ? {}
        : { capabilityId: parsed.positional[0] }),
      signal: controller.signal
    });
    process.stdout.write(
      json
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderFoundationReportText(report)
    );
    process.exitCode = exitCodeForOutcome(report.outcome);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
  return true;
}

async function runProtobufQualificationCommand(
  parsed: ParsedArguments,
  json: boolean
): Promise<boolean> {
  if (parsed.command !== "protobuf-qualify-breaking") {
    return false;
  }
  if (parsed.bufExecutablePath === undefined) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "protobuf-qualify-breaking requires --buf-executable <absolute-path>."
    );
  }
  const settings = await loadFoundationConfig(parsed.consumerRoot);
  const declaration = settings.declaredCapabilities.find(
    ({ id }) => id === "contract.protobuf-evolution"
  );
  if (declaration === undefined) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "contract.protobuf-evolution must be declared before Buf qualification."
    );
  }
  const { qualifyProtobufBreakingEvidence } = await import(
    "./capabilities/contract-protobuf-evolution/qualification/module.js"
  );
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const qualification = await qualifyProtobufBreakingEvidence({
      consumerRoot: parsed.consumerRoot,
      configPath: declaration.configPath,
      executablePath: parsed.bufExecutablePath,
      write: parsed.write,
      signal: controller.signal
    });
    process.stdout.write(
      json
        ? `${JSON.stringify({ qualification }, null, 2)}\n`
        : `Buf FILE qualification ${qualification.writeResult}: ${qualification.status} (${qualification.evidencePath}).\n`
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  return true;
}

async function runAgentWorkflowCommand(
  parsed: ParsedArguments,
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  if (parsed.command !== "agent-workflow") {
    return false;
  }
  const subcommand = parsed.positional[0];
  if (subcommand !== "changed" && subcommand !== "instructions") {
    throw new FoundationError("CONSUMER_INVALID", "agent-workflow requires the changed or instructions subcommand.");
  }
  const targetPath = parsed.positional[1];
  if (subcommand === "instructions" && parsed.positional.length !== 2) {
    throw new FoundationError("CONSUMER_INVALID", "agent-workflow instructions requires exactly one repository-relative file path.");
  }
  if (subcommand === "changed" && parsed.positional.length !== 1) {
    throw new FoundationError("CONSUMER_INVALID", "agent-workflow changed does not accept a target path.");
  }
  const settings = await loadFoundationConfig(parsed.consumerRoot);
  const declaration = settings.declaredCapabilities.find(
    ({ id }) => id === "repository.agent-workflow"
  );
  if (declaration === undefined) {
    throw new FoundationError("CONSUMER_INVALID", "The consumer must declare repository.agent-workflow before using its commands.");
  }
  if (subcommand === "instructions") {
    await runAgentWorkflowInstructionsCommand({
      consumerRoot: parsed.consumerRoot,
      format: parsed.format,
      targetPath: targetPath as string
    });
    return true;
  }
  await runAgentWorkflowChangedCommand({
    consumerRoot: parsed.consumerRoot,
    configPath: declaration.configPath,
    format: parsed.format,
    pnpmEnvironment: {
      ...(environment.npm_execpath === undefined
        ? {}
        : { npmExecPath: environment.npm_execpath }),
      ...(environment.PNPM_HOME === undefined
        ? {}
        : { pnpmHome: environment.PNPM_HOME }),
      ...(environment.PATH === undefined
        ? {}
        : { pathValue: environment.PATH })
    },
    ...(parsed.baseRef === undefined ? {} : { baseRef: parsed.baseRef })
  });
  return true;
}

async function runPolicyCommand(
  parsed: ParsedArguments,
  json: boolean
): Promise<boolean> {
  switch (parsed.command) {
    case "explain": {
      const ruleId = parsed.positional[0];
      if (ruleId === undefined) {
        throw new FoundationError("CONSUMER_INVALID", "explain requires a rule ID.");
      }
      const metadata = RULE_REGISTRY.get(ruleId);
      if (metadata === undefined) {
        throw new FoundationError("CONSUMER_INVALID", `Unknown rule ID: ${ruleId}.`);
      }
      process.stdout.write(
        json
          ? `${JSON.stringify(metadata, null, 2)}\n`
          : `${metadata.id}\n${metadata.rationale}\nFix: ${metadata.remediation}\nDocs: ${metadata.documentation}\n`
      );
      return true;
    }
    case "public-api-promote-release": {
      const settings = await loadFoundationConfig(parsed.consumerRoot);
      const declaration = settings.declaredCapabilities.find(
        ({ id }) => id === "package.public-api-compatibility"
      );
      if (declaration === undefined) {
        throw new FoundationError(
          "CONSUMER_INVALID",
          "package.public-api-compatibility must be declared before baseline promotion."
        );
      }
      const snapshots = await promotePublicApiRelease({
        consumerRoot: parsed.consumerRoot,
        configPath: declaration.configPath
      });
      process.stdout.write(
        json
          ? `${JSON.stringify({ promoted: snapshots }, null, 2)}\n`
          : `Promoted ${snapshots.length} public API baseline(s).\n`
      );
      return true;
    }
    default:
      return false;
  }
}

async function runInformationCommand(
  parsed: ParsedArguments,
  json: boolean
): Promise<boolean> {
  if (await runScaffoldingCliCommand(parsed, json)) {
    return true;
  }
  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h": {
      printHelp();
      return true;
    }
    case "self-check": {
      const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
      const result = await inspectFoundationPackage(packageRoot);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return true;
    }
    case "schema": {
      const schemaId = parsed.positional[0];
      if (schemaId === undefined || !isFoundationSchemaId(schemaId)) {
        throw new FoundationError(
          "CONSUMER_INVALID",
          `Unknown schema ID: ${schemaId ?? "missing"}.`
        );
      }
      process.stdout.write(await readFoundationSchema(schemaId));
      return true;
    }
    case "version":
    case "--version":
    case "-v": {
      process.stdout.write(`${await installedFoundationVersion()}\n`);
      return true;
    }
    default:
      return false;
  }
}

async function main(environment: NodeJS.ProcessEnv): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const json = parsed.format === "json";
  const service = new FoundationLocalModeService({
    runner: createNodeProcessRunner(environment),
    now: systemNow
  });
  if (
    await runLocalModeCommand(parsed, service, json) ||
    await tryRunQualityGateCliCommand(parsed, environment) ||
    await runAgentWorkflowCommand(parsed, environment) ||
    await runProtobufQualificationCommand(parsed, json) ||
    await runCheckCommand(parsed, json) ||
    await runPolicyCommand(parsed, json) ||
    await runInformationCommand(parsed, json)
  ) {
    return;
  }
  throw new FoundationError(
    "CONSUMER_INVALID",
    `Unknown command: ${parsed.command}.`
  );
}

try {
  await main(process.env);
} catch (error) {
  if (
    process.argv.slice(2).includes("--json") ||
    process.argv.slice(2).some(
      (argument, index, arguments_) =>
        argument === "--format" && arguments_[index + 1] === "json"
    )
  ) {
    const failure = foundationCommandFailure(error);
    process.stdout.write(`${JSON.stringify(failure.envelope)}\n`);
    process.exitCode = failure.exitCode;
  } else if (error instanceof FoundationTransactionError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof ScaffoldError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode =
      error.code === "SCAFFOLD_INPUT_INVALID" ||
      error.code === "SCAFFOLD_PLAN_INVALID"
        ? 2
        : 1;
  } else if (error instanceof CapabilityInputError) {
    process.stderr.write(`${error.problem.code}: ${error.problem.message}\n`);
    process.exitCode = error.problem.code === "EXECUTION_CANCELLED" ? 130 : 2;
  } else if (error instanceof ProcessCancellationError) {
    process.stderr.write(`PROCESS_CANCELLED: ${error.message}\n`);
    process.exitCode = 130;
  } else if (error instanceof FoundationError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.code === "CONSUMER_INVALID" ? 2 : 1;
  } else {
    process.stderr.write(
      `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
