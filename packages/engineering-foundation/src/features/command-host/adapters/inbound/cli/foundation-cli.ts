import {
  invalidCommand,
  checkCommandExitCode,
  commandInputText,
  commandFoundationText,
  selectedCommandReport,
} from "../../../application/command-reporting.js";
import {
  commandTransactionText,
  commandCancellationText,
} from "../../../application/command-failure.js";
import { printStatus, printDevOnlyStatus, printHelp } from "./cli-output.js";
import { dispatchFoundationCommand, type FoundationCommandServices } from "../../../api.js";
import { parseArguments, type ParsedArguments } from "./cli-arguments.js";
import { foundationCommandFailure } from "./command-error.js";

async function runLocalModeCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  service: FoundationCommandServices<SchemaId>["localMode"],
  json: boolean,
): Promise<boolean> {
  switch (parsed.command) {
    case "attach": {
      const target = parsed.positional[0];
      if (target === undefined) {
        throw invalidCommand("attach requires a foundation repository or package path.");
      }
      const result = await service.attach(parsed.consumerRoot, target);
      printStatus(result.status, json);
      return true;
    }
    case "assert-dev-only": {
      printDevOnlyStatus(await service.assertDevOnly(parsed.consumerRoot), json);
      return true;
    }
    case "assert-registry": {
      printStatus(await service.assertRegistry(parsed.consumerRoot), json);
      return true;
    }
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

async function runCheckCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  json: boolean,
): Promise<boolean> {
  if (parsed.command !== "check") {
    return false;
  }
  await services.cancellation.withSignal(["SIGINT"], async (signal) => {
    const report = await services.check({
      consumerRoot: parsed.consumerRoot,
      foundationVersion: await services.installedVersion(),
      ...(parsed.positional[0] === undefined ? {} : { capabilityId: parsed.positional[0] }),
      signal,
    });
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : services.renderCheck(report),
    );
    process.exitCode = checkCommandExitCode(report.outcome);
  });
  return true;
}

async function runQualityCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  json: boolean,
): Promise<boolean> {
  if (parsed.command !== "quality") {
    return false;
  }
  if (parsed.positional.length !== 1 || parsed.positional[0] !== "check") {
    throw invalidCommand("quality requires the check subcommand.");
  }
  await services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) => {
    const settings = await services.readConfig(parsed.consumerRoot, signal);
    const declaration = settings.declaredCapabilities.find(
      ({ id }) => id === "quality.source-coverage",
    );
    if (declaration === undefined) {
      throw invalidCommand("quality.source-coverage must be declared before quality check.");
    }
    const report = selectedCommandReport(
      await services.qualityCoverage({
        consumerRoot: parsed.consumerRoot,
        configPath: declaration.configPath,
        scopeOnly: parsed.scopeOnly === true,
        signal,
      }),
      await services.installedVersion(),
    );
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : services.renderCheck(report),
    );
    process.exitCode = checkCommandExitCode(report.outcome);
  });
  return true;
}

async function runBaselineCommand<SchemaId extends string>(
  services: FoundationCommandServices<SchemaId>,
  parsed: ParsedArguments,
  json: boolean,
): Promise<boolean> {
  if (parsed.command !== "baseline") {
    return false;
  }
  const action = parsed.positional[0];
  if (action !== "check" && action !== "init" && action !== "prune") {
    throw invalidCommand("baseline requires the check, init or prune subcommand.");
  }
  await services.cancellation.withSignal(["SIGINT", "SIGTERM"], async (signal) => {
    const invocation = { consumerRoot: parsed.consumerRoot, configPath: parsed.configPath, signal };
    if (action === "check") {
      const report = selectedCommandReport(
        await services.findingsBaseline.check(invocation),
        await services.installedVersion(),
      );
      process.stdout.write(
        json ? `${JSON.stringify(report, null, 2)}\n` : services.renderCheck(report),
      );
      process.exitCode = checkCommandExitCode(report.outcome);
      return;
    }
    const result = await services.findingsBaseline.write({ ...invocation, action });
    process.stdout.write(
      json
        ? `${JSON.stringify({ baseline: result }, null, 2)}\n`
        : `Findings baseline ${result.action} ${result.path}: ${result.entries} entries, ${result.lowered} lowered, ${result.removed} removed.\n` +
            result.remaining
              .map(({ kind, path, rule }) => `Not accepted (${kind}): ${path} ${rule}\n`)
              .join(""),
    );
    // A new or worse finding stays a failure of the check; pruning cannot accept it.
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
): Promise<boolean> {
  if (await services.scaffold(parsed, json)) {
    return true;
  }
  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h": {
      if (json) {
        throw invalidCommand("--json is not accepted by help.");
      }
      printHelp();
      return true;
    }
    case "self-check": {
      const result = await services.inspectPackage();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return true;
    }
    case "schema": {
      const schemaId = parsed.positional[0];
      if (schemaId === undefined || !services.isSchemaId(schemaId)) {
        throw invalidCommand(`Unknown schema ID: ${schemaId ?? "missing"}.`);
      }
      process.stdout.write(await services.readSchema(schemaId));
      return true;
    }
    case "version":
    case "--version":
    case "-v": {
      if (json) {
        throw invalidCommand("--json is not accepted by version.");
      }
      process.stdout.write(`${await services.installedVersion()}\n`);
      return true;
    }
    default:
      return false;
  }
}

async function main<SchemaId extends string>(
  createServices: () => FoundationCommandServices<SchemaId>,
  args: readonly string[],
): Promise<void> {
  const parsed = parseArguments(args);
  const json = parsed.format === "json";
  const services = createServices();
  await dispatchFoundationCommand(parsed, [
    (input) => runLocalModeCommand(services, input, services.localMode, json),
    services.qualityGate,
    (input) => runQualityCommand(services, input, json),
    (input) => runBaselineCommand(services, input, json),
    (input) => runAgentWorkflowCommand(services, input),
    (input) => runProtobufQualificationCommand(services, input, json),
    (input) => runCheckCommand(services, input, json),
    (input) => runPolicyCommand(services, input, json),
    (input) => runInformationCommand(services, input, json),
  ]);
}

export async function runFoundationCli<SchemaId extends string>(
  createServices: () => FoundationCommandServices<SchemaId>,
  args: readonly string[],
): Promise<void> {
  try {
    await main(createServices, args);
  } catch (error) {
    if (
      args.includes("--json") ||
      args.some(
        (argument, index, arguments_) =>
          argument === "--format" && arguments_[index + 1] === "json",
      )
    ) {
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
