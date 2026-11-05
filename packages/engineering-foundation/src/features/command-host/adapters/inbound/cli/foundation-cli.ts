import {
  invalidCommand,
  checkCommandExitCode,
  commandInputText,
  commandFoundationText,
} from "../../../application/command-reporting.js";
import {
  commandTransactionText,
  commandCancellationText,
} from "../../../application/command-failure.js";
import { printStatus, printDevOnlyStatus, printHelp } from "./cli-output.js";
import {
  dispatchFoundationCommand,
  admitLocalModeCommand,
  executeLocalModeCommand,
  admitCheckCommand,
  executeCheckCommand,
  admitQualityCommand,
  executeQualityCommand,
  admitBaselineCommand,
  executeBaselineCommand,
  admitInformationCommand,
  executeInformationCommand,
  type FoundationCommandServices,
  type LocalModeCommand,
  type CheckCommand,
  type QualityCommand,
  type BaselineCommand,
  type InformationCommand,
} from "../../../api.js";
import { admitArguments, type ParsedArguments } from "./cli-arguments.js";
import type { OutputFormat } from "../../../application/command-invocation.js";
import { foundationCommandFailure } from "./command-error.js";

async function runLocalModeCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  input: LocalModeCommand | undefined,
  json: boolean,
): Promise<boolean> {
  if (input === undefined) {
    return false;
  }
  const result = await executeLocalModeCommand(services.localMode, input);
  if (result.kind === "dev-only") {
    printDevOnlyStatus(result.status, json);
  } else {
    printStatus(result.status, json);
    if (result.kind === "inspection" && result.status.mode === "INVALID") {
      process.exitCode = 1;
    }
  }
  return true;
}

function publishCheckReport(
  report: Awaited<ReturnType<FoundationCommandServices["check"]>>,
  json: boolean,
  services: Pick<FoundationCommandServices, "renderCheck">,
): void {
  process.stdout.write(
    json ? `${JSON.stringify(report, null, 2)}\n` : services.renderCheck(report),
  );
  process.exitCode = checkCommandExitCode(report.outcome);
}

async function runCheckCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  input: CheckCommand | undefined,
  json: boolean,
): Promise<boolean> {
  if (input === undefined) {
    return false;
  }
  await executeCheckCommand(services, input, (report) => {
    publishCheckReport(report, json, services);
  });
  return true;
}

async function runQualityCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  input: QualityCommand | undefined,
  json: boolean,
): Promise<boolean> {
  if (input === undefined) {
    return false;
  }
  await executeQualityCommand(services, input, (report) => {
    publishCheckReport(report, json, services);
  });
  return true;
}

async function runBaselineCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  input: BaselineCommand | undefined,
  json: boolean,
): Promise<boolean> {
  if (input === undefined) {
    return false;
  }
  await executeBaselineCommand(services, input, (output) => {
    if (output.kind === "check") {
      publishCheckReport(output.report, json, services);
      return;
    }
    const result = output.result;
    process.stdout.write(
      json
        ? `${JSON.stringify({ baseline: result }, null, 2)}\n`
        : `Findings baseline ${result.action} ${result.path}: ${result.entries} entries, ${result.lowered} lowered, ${result.removed} removed.\n` +
            result.remaining
              .map(({ kind, path, rule }) => `Not accepted (${kind}): ${path} ${rule}\n`)
              .join(""),
    );
    if (result.remaining.length > 0) {
      process.exitCode = 1;
    }
  });
  return true;
}

async function runProtobufQualificationCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  json: boolean,
): Promise<boolean> {
  if (parsed.command !== "protobuf-qualify-breaking") {
    return false;
  }
  if (parsed.bufExecutablePath === undefined) {
    throw invalidCommand("protobuf-qualify-breaking requires --buf-executable <absolute-path>.");
  }
  const settings = await services.readConfig(parsed.consumerRoot);
  const declaration = settings.declaredCapabilities.find(
    ({ id }) => id === "contract.protobuf-evolution",
  );
  if (declaration === undefined) {
    throw invalidCommand("contract.protobuf-evolution must be declared before Buf qualification.");
  }
  const qualifyProtobuf = await services.loadProtobufQualifier();
  const executablePath = parsed.bufExecutablePath;
  await services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) => {
    const qualification = await qualifyProtobuf({
      consumerRoot: parsed.consumerRoot,
      configPath: declaration.configPath,
      executablePath,
      write: parsed.write,
      signal,
    });
    process.stdout.write(
      json
        ? `${JSON.stringify({ qualification }, null, 2)}\n`
        : `Buf FILE qualification ${qualification.writeResult}: ${qualification.status} (${qualification.evidencePath}).\n`,
    );
  });
  return true;
}

async function runAgentWorkflowCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
): Promise<boolean> {
  if (parsed.command !== "agent-workflow") {
    return false;
  }
  const subcommand = parsed.positional[0];
  if (subcommand !== "changed" && subcommand !== "check-changed" && subcommand !== "instructions") {
    throw invalidCommand(
      "agent-workflow requires the changed, check-changed or instructions subcommand.",
    );
  }
  const targetPath = parsed.positional[1];
  if (subcommand === "instructions" && parsed.positional.length !== 2) {
    throw invalidCommand(
      "agent-workflow instructions requires exactly one repository-relative file path.",
    );
  }
  if (
    (subcommand === "changed" || subcommand === "check-changed") &&
    parsed.positional.length !== 1
  ) {
    throw invalidCommand(`agent-workflow ${subcommand} does not accept a target path.`);
  }
  const settings = await services.readConfig(parsed.consumerRoot);
  const declaration = settings.declaredCapabilities.find(
    ({ id }) => id === "repository.agent-workflow",
  );
  if (declaration === undefined) {
    throw invalidCommand(
      "The consumer must declare repository.agent-workflow before using its commands.",
    );
  }
  if (subcommand === "instructions") {
    await services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) =>
      services.agentWorkflow.instructions({
        signal,
        consumerRoot: parsed.consumerRoot,
        format: parsed.format,
        targetPath: targetPath as string,
      }),
    );
    return true;
  }
  await services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) => {
    const options = {
      signal,
      consumerRoot: parsed.consumerRoot,
      configPath: declaration.configPath,
      format: parsed.format,
      ...(parsed.baseRef === undefined ? {} : { baseRef: parsed.baseRef }),
    };
    return subcommand === "check-changed"
      ? services.agentWorkflow.checkChanged(options)
      : services.agentWorkflow.changed(options);
  });
  return true;
}

async function runPolicyCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  json: boolean,
): Promise<boolean> {
  switch (parsed.command) {
    case "architecture-decisions-promote-baseline": {
      const settings = await services.readConfig(parsed.consumerRoot);
      const declaration = settings.declaredCapabilities.find(
        ({ id }) => id === "governance.architecture-decisions",
      );
      if (declaration === undefined) {
        throw invalidCommand(
          "governance.architecture-decisions must be declared before baseline promotion.",
        );
      }
      const promotion = await services.promoteDecisions({
        consumerRoot: parsed.consumerRoot,
        configPath: declaration.configPath,
      });
      process.stdout.write(
        json
          ? `${JSON.stringify({ promotion }, null, 2)}\n`
          : `Architecture-decision baseline ${promotion.writeResult}.\n`,
      );
      return true;
    }
    case "explain": {
      const ruleId = parsed.positional[0];
      if (ruleId === undefined) {
        throw invalidCommand("explain requires a rule ID.");
      }
      const metadata = services.rules.get(ruleId);
      if (metadata === undefined) {
        throw invalidCommand(`Unknown rule ID: ${ruleId}.`);
      }
      process.stdout.write(
        json
          ? `${JSON.stringify(metadata, null, 2)}\n`
          : `${metadata.id}\n${metadata.rationale}\nFix: ${metadata.remediation}\nDocs: ${metadata.documentation}\n`,
      );
      return true;
    }
    case "public-api-audit": {
      try {
        const report = await services.cancellation.withSignal(["SIGINT", "SIGTERM"], (signal) =>
          services.auditPublicApi({
            consumerRoot: parsed.consumerRoot,
            configPath: parsed.configPath,
            signal,
          }),
        );
        process.stdout.write(`${JSON.stringify(report)}\n`);
        process.exitCode = report.exitCode;
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, operation: "public-api-audit", releaseEligible: false, evidenceComplete: false, exitCode: 2, errors: [String(error)] })}\n`,
        );
        process.exitCode = 2;
      }
      return true;
    }
    case "public-api-promote-release": {
      const settings = await services.readConfig(parsed.consumerRoot);
      const declaration = settings.declaredCapabilities.find(
        ({ id }) => id === "package.public-api-compatibility",
      );
      if (declaration === undefined) {
        throw invalidCommand(
          "package.public-api-compatibility must be declared before baseline promotion.",
        );
      }
      if (parsed.nativeTransitionPath !== undefined) {
        const result = await services.cancellation.withSignal(["SIGINT", "SIGTERM"], (signal) =>
          services.nativePublicApiTransition({
            consumerRoot: parsed.consumerRoot,
            configPath: declaration.configPath,
            requestPath: parsed.nativeTransitionPath!,
            qualificationOnly: parsed.qualificationOnly === true,
            signal,
          }),
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return true;
      }
      const snapshots = await services.promotePublicApi({
        consumerRoot: parsed.consumerRoot,
        configPath: declaration.configPath,
      });
      process.stdout.write(
        json
          ? `${JSON.stringify({ promoted: snapshots }, null, 2)}\n`
          : `Promoted ${snapshots.length} public API baseline(s).\n`,
      );
      return true;
    }
    default:
      return false;
  }
}

async function runInformationCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  json: boolean,
  input: InformationCommand | undefined,
): Promise<boolean> {
  if (await services.scaffold(parsed, json)) {
    return true;
  }
  if (input === undefined) {
    return false;
  }
  const result = await executeInformationCommand(services, input);
  switch (result.kind) {
    case "help":
      printHelp();
      break;
    case "text":
      process.stdout.write(result.text);
      break;
    case "package":
      process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`);
      break;
  }
  return true;
}

async function main<SchemaId extends string>(
  createServices: () => FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
): Promise<void> {
  const json = parsed.format === "json";
  // Prepare the buffered commands before constructing any effectful services.
  const localMode = admitLocalModeCommand(parsed);
  const check = admitCheckCommand(parsed);
  const quality = admitQualityCommand(parsed);
  const baseline = admitBaselineCommand(parsed);
  const information = admitInformationCommand(parsed);
  const services = createServices();
  await dispatchFoundationCommand(parsed, [
    () => runLocalModeCommand(services, localMode, json),
    services.qualityGate,
    () => runQualityCommand(services, quality, json),
    () => runBaselineCommand(services, baseline, json),
    (input) => runAgentWorkflowCommand(services, input),
    (input) => runProtobufQualificationCommand(services, input, json),
    () => runCheckCommand(services, check, json),
    (input) => runPolicyCommand(services, input, json),
    (input) => runInformationCommand(services, input, json, information),
  ]);
}

export async function runFoundationCli<SchemaId extends string>(
  createServices: () => FoundationCommandServices<SchemaId>,
  args: readonly string[],
): Promise<void> {
  let format: OutputFormat = "text";
  try {
    const admission = admitArguments(args);
    format = admission.kind === "admitted" ? admission.invocation.format : admission.format;
    if (admission.kind === "invalid") {
      throw admission.error;
    }
    await main(createServices, admission.invocation);
  } catch (error) {
    if (format === "json") {
      const failure = foundationCommandFailure(error);
      process.stdout.write(`${JSON.stringify(failure.envelope)}\n`);
      process.exitCode = failure.exitCode;
    } else {
      const failure = commandTransactionText(error);
      if (failure !== undefined) {
        process.stderr.write(failure.text);
        process.exitCode = failure.exitCode;
      } else {
        printExecutionFailure(error);
      }
    }
  }
}

function printExecutionFailure(error: unknown): void {
  const inputFailure = commandInputText(error);
  if (inputFailure !== undefined) {
    process.stderr.write(inputFailure.text);
    process.exitCode = inputFailure.exitCode;
  } else {
    const failure = commandCancellationText(error) ?? commandFoundationText(error);
    process.stderr.write(
      failure?.text ?? `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = failure?.exitCode ?? 1;
  }
}
