#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FoundationError } from "./errors.js";
import { NodeProcessRunner } from "./local-mode/process-runner.js";
import { FoundationLocalModeService } from "./local-mode/service.js";
import type { FoundationStatus } from "./local-mode/types.js";

interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly json: boolean;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let consumerRoot = process.cwd();
  let json = false;

  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--consumer") {
      const candidate = args[index + 1];
      if (candidate === undefined) {
        throw new FoundationError(
          "CONSUMER_INVALID",
          "--consumer requires a path."
        );
      }
      consumerRoot = resolve(candidate);
      index += 1;
    } else if (value === "--json") {
      json = true;
    } else if (value !== undefined) {
      positional.push(value);
    }
  }

  return {
    command: args[0] ?? "help",
    positional,
    consumerRoot,
    json
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

function printHelp(): void {
  process.stdout.write(`Usage:
  agent-teams-foundation attach <path> [--consumer <path>]
  agent-teams-foundation status [--consumer <path>] [--json]
  agent-teams-foundation detach [--consumer <path>] [--json]
  agent-teams-foundation assert-registry [--consumer <path>] [--json]
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

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const service = new FoundationLocalModeService({
    runner: new NodeProcessRunner()
  });

  switch (parsed.command) {
    case "attach": {
      const target = parsed.positional[0];
      if (target === undefined) {
        throw new FoundationError(
          "PACKAGE_INVALID",
          "attach requires a foundation repository or package path."
        );
      }
      const result = await service.attach(parsed.consumerRoot, target);
      printStatus(result.status, parsed.json);
      break;
    }
    case "assert-registry": {
      printStatus(
        await service.assertRegistry(parsed.consumerRoot),
        parsed.json
      );
      break;
    }
    case "detach": {
      printStatus(await service.detach(parsed.consumerRoot), parsed.json);
      break;
    }
    case "help":
    case "--help":
    case "-h": {
      printHelp();
      break;
    }
    case "status": {
      const status = await service.status(parsed.consumerRoot);
      printStatus(status, parsed.json);
      if (status.mode === "INVALID") {
        process.exitCode = 1;
      }
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      process.stdout.write(`${await packageVersion()}\n`);
      break;
    }
    default: {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Unknown command: ${parsed.command}.`
      );
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof FoundationError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(
      `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
  process.exitCode = 1;
}
