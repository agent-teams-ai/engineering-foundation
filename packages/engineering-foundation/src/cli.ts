#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CapabilityInputError, exitCodeForOutcome } from "./capability-runtime.js";
import { promotePublicApiRelease } from "./capabilities/public-api-compatibility/module.js";
import { runFoundationCheck } from "./check-runner.js";
import { RULE_REGISTRY } from "./composition/rule-registry.js";
import { FoundationError } from "./errors.js";
import { loadFoundationConfig } from "./foundation-config.js";
import { systemNow } from "./local-mode/adapters/outbound/time/system-clock.js";
import { NodeProcessRunner } from "./local-mode/process-runner.js";
import { FoundationLocalModeService } from "./local-mode/service.js";
import type {
  FoundationDevOnlyStatus,
  FoundationStatus
} from "./local-mode/types.js";
import { inspectFoundationPackage } from "./package-self-check.js";
import { renderFoundationReportText } from "./report-renderer.js";
import { runScaffoldingCliCommand } from "./scaffolding/cli-command.js";
import { ScaffoldError } from "./scaffolding/scaffold-error.js";
import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "./scaffolding/service.js";
import {
  isFoundationSchemaId,
  readFoundationSchema
} from "./schema-catalog.js";

type OutputFormat = "json" | "text";

interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly format: OutputFormat;
}

const MAX_POSITIONAL_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({
  "--help": 0,
  "--version": 0,
  "-h": 0,
  "-v": 0,
  "assert-dev-only": 0,
  "assert-registry": 0,
  attach: 1,
  check: 1,
  detach: 0,
  explain: 1,
  help: 0,
  "public-api-promote-release": 0,
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
  configPath: string;
  configPathProvided: boolean;
  consumerRoot: string;
  format: OutputFormat;
  optionsEnded: boolean;
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
  if (state.optionsEnded) {
    state.positional.push(value);
    return 0;
  }
  if (value === "--") {
    state.optionsEnded = true;
    return 0;
  }
  if (value === "--json") {
    state.format = "json";
    return 0;
  }
  if (value === "--consumer") {
    const candidate = args[index + 1];
    if (candidate === undefined || candidate.length === 0) {
      throw new FoundationError("CONSUMER_INVALID", "--consumer requires a path.");
    }
    state.consumerRoot = resolve(candidate);
    return 1;
  }
  if (value === "--config") {
    const candidate = args[index + 1];
    if (candidate === undefined || candidate.length === 0) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        "--config requires a repository-relative path."
      );
    }
    state.configPath = candidate;
    state.configPathProvided = true;
    return 1;
  }
  if (value === "--format") {
    const candidate = args[index + 1];
    if (candidate !== "json" && candidate !== "text") {
      throw new FoundationError("CONSUMER_INVALID", "--format requires json or text.");
    }
    state.format = candidate;
    return 1;
  }
  if (value.startsWith("-")) {
    throw new FoundationError("CONSUMER_INVALID", `Unknown option: ${value}.`);
  }
  state.positional.push(value);
  return 0;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const state: ArgumentState = {
    positional: [],
    configPath: DEFAULT_SCAFFOLDING_CONFIG_PATH,
    configPathProvided: false,
    consumerRoot: process.cwd(),
    format: "text",
    optionsEnded: false
  };

  for (let index = 1; index < args.length; index += 1) {
    index += consumeArgument(args, index, state);
  }

  const command = args[0] ?? "help";
  if (state.configPathProvided && command !== "scaffold-plan") {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "--config is supported only by scaffold-plan."
    );
  }
  const maximum = MAX_POSITIONAL_ARGUMENTS[command];
  if (maximum !== undefined && state.positional.length > maximum) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      `${command} accepts at most ${maximum} positional argument${maximum === 1 ? "" : "s"}.`
    );
  }

  return {
    command,
    positional: state.positional,
    consumerRoot: state.consumerRoot,
    configPath: state.configPath,
    format: state.format
  };
}

function printStatus(status: FoundationStatus, json: boolean): void {
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
  agent-teams-foundation explain <rule-id> [--format text|json]
  agent-teams-foundation public-api-promote-release [--consumer <path>] [--json]
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

async function packageVersion(): Promise<string> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8")
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation package version is unavailable."
    );
  }
  return manifest.version;
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
      foundationVersion: await packageVersion(),
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
      process.stdout.write(`${await packageVersion()}\n`);
      return true;
    }
    default:
      return false;
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const json = parsed.format === "json";
  const service = new FoundationLocalModeService({
    runner: new NodeProcessRunner(),
    now: systemNow
  });
  if (
    await runLocalModeCommand(parsed, service, json) ||
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
  await main();
} catch (error) {
  if (error instanceof ScaffoldError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode =
      error.code === "SCAFFOLD_INPUT_INVALID" ||
      error.code === "SCAFFOLD_PLAN_INVALID"
        ? 2
        : 1;
  } else if (error instanceof CapabilityInputError) {
    process.stderr.write(`${error.problem.code}: ${error.problem.message}\n`);
    process.exitCode = 2;
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
