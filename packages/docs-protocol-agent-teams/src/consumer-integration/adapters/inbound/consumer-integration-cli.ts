import type {
  createConsumerIntegrationUseCases,
  createConsumerUpgradeUseCase,
  ConsumerIntegrationExecutionV1,
  ConsumerUpgradeExecutionV1
} from "../../application-api.js";
import {
  assertConsumerIntegrationExecutionSchema,
  assertConsumerUpgradeExecutionSchema
} from "../consumer-integration-schema-validator.js";

class ConsumerCliInputError extends Error {
  readonly code = "DOCS_CONSUMER_CLI_INVALID";
}

const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const MAXIMUM_ARGUMENT_LENGTH = 4096;
const MAXIMUM_ARGUMENTS = 32;

class Arguments {
  readonly #values: string[];
  readonly #used = new Set<number>();

  public constructor(values: readonly string[]) {
    this.#values = [...values];
  }

  public flag(name: string): boolean {
    const indexes = this.#values.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) {throw new ConsumerCliInputError(`${name} may be supplied only once.`);}
    if (indexes[0] !== undefined) {this.#used.add(indexes[0]);}
    return indexes.length === 1;
  }

  public one(name: string, required = false): string | undefined {
    const indexes = this.#values.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) {throw new ConsumerCliInputError(`${name} may be supplied only once.`);}
    const index = indexes[0];
    if (index === undefined) {
      if (required) {throw new ConsumerCliInputError(`${name} is required.`);}
      return undefined;
    }
    const value = this.#values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ConsumerCliInputError(`${name} requires a value.`);
    }
    if (value.length > MAXIMUM_ARGUMENT_LENGTH || value.includes("\u0000")) {
      throw new ConsumerCliInputError(`${name} contains an invalid or overlong value.`);
    }
    this.#used.add(index);
    this.#used.add(index + 1);
    return value;
  }

  public assertConsumed(): void {
    const unknown = this.#values.filter((_value, index) => !this.#used.has(index));
    if (unknown.length > 0) {
      throw new ConsumerCliInputError(`Unknown consumer arguments: ${unknown.join(" ")}.`);
    }
  }
}

type ConsumerExecution = ConsumerIntegrationExecutionV1 | ConsumerUpgradeExecutionV1;

function failure(command: string, error: unknown): ConsumerExecution {
  const candidateCode = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : "DOCS_CONSUMER_EXECUTION_FAILURE";
  const code = /^(?:DOCS_|KNOWN_)[A-Z0-9_]{1,122}$/u.test(candidateCode)
    ? candidateCode
    : "DOCS_CONSUMER_EXECUTION_FAILURE";
  const rawMessage = error instanceof Error ? error.message : "Consumer integration failed.";
  let safeMessage = "";
  for (const character of rawMessage
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|private|var|Volumes)\/)[^\s'"`]+/gu, "<local-path>")) {
    const codePoint = character.codePointAt(0) ?? 0;
    safeMessage += (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127
      ? "?"
      : character;
  }
  safeMessage = safeMessage.slice(0, 4096);
  if (command === "upgrade") {
    return {
      schemaVersion: 1,
      command: "consumer.upgrade",
      outcome: "blocked",
      issues: [{ code, severity: "error", subject: command, message: safeMessage }]
    };
  }
  const commandId = ["apply", "check", "plan", "recover"].includes(command)
    ? `consumer.${command}` as ConsumerIntegrationExecutionV1["command"]
    : "consumer.check";
  return {
    schemaVersion: 1,
    command: commandId,
    outcome: "blocked",
    issues: [{
      code,
      severity: "error",
      subject: command.slice(0, 2048),
      message: safeMessage
    }]
  };
}

function human(execution: ConsumerExecution): string {
  const lines = [`${execution.command}: ${execution.outcome}`];
  if (execution.command !== "consumer.upgrade" && execution.plan !== undefined) {
    lines.push(`Cohort: ${execution.plan.cohortId}`);
    lines.push(`Plan: ${execution.plan.planDigest}`);
    for (const asset of execution.plan.assets) {
      const current = asset.currentDigest === undefined ? "absent" : asset.currentDigest;
      lines.push(`${asset.action.padEnd(7)} ${asset.path} (${asset.ownership}, ${asset.state})`);
      if (asset.action !== "none") {
        lines.push(`        ${current} -> ${asset.expectedDigest}`);
      }
    }
  }
  if (execution.receipt !== undefined) {
    lines.push(`Receipt: ${execution.receipt.receiptDigest}`);
  }
  for (const issue of execution.issues) {
    lines.push(`${issue.severity.toUpperCase()} ${issue.code} [${issue.subject}]: ${issue.message}`);
    lines.push(issue.code === "DOCS_CONSUMER_STALE_PLAN"
      ? "Next: run agent-teams-docs-managed plan again and review the new digest."
      : issue.code.includes("RECOVERY") || issue.code.startsWith("KNOWN_FILE")
        ? "Next: run agent-teams-docs-managed recover, then repeat check and plan."
        : "Next: fix the reported authority or conflict, then repeat check and plan.");
  }
  return `${lines.join("\n")}\n`;
}

function exitCode(execution: ConsumerExecution): number {
  if (["applied", "current", "recovered", "upgraded"].includes(execution.outcome)) {return 0;}
  if (execution.outcome === "change-required") {return 1;}
  const codes = new Set(execution.issues.map(({ code }) => code));
  if (codes.has("DOCS_CONSUMER_CLI_INVALID")) {return 2;}
  return codes.has("DOCS_CONSUMER_EXECUTION_FAILURE") ? 3 : 1;
}

function assertBoundedArgv(argv: readonly string[]): void {
  if (argv.length > MAXIMUM_ARGUMENTS || argv.some((value) =>
    typeof value !== "string" || value.length > MAXIMUM_ARGUMENT_LENGTH || value.includes("\u0000")
  )) {
    throw new ConsumerCliInputError("Consumer arguments are invalid or exceed the bounded CLI contract.");
  }
}

function requestsJsonOutput(argv: readonly string[]): boolean {
  return argv.some((value) => value === "--json");
}

export function managedDocsHelp(): string {
  return `Usage: agent-teams-docs-managed <command> [options]

Commands:
  check                         Verify the selected Cohort without writing
  plan --to COHORT              Print a deterministic, write-free semantic plan
  apply --expect SHA256         Rebuild and apply the reviewed plan through Foundation
  upgrade --to COHORT --target-generation 1|2  Project authority, pins, lockfile, and assets
  recover                       Recover the Foundation transaction (profile not read)

Options:
  --consumer PATH               Git repository root (default: .)
  --authority-revision SHA      Optional exact protected .github revision
  --json                        Emit one bounded versioned JSON envelope
  --help                        Show this help
`;
}

export function createManagedConsumerCommand(operations:
  ReturnType<typeof createConsumerIntegrationUseCases> & {
    readonly upgrade: (options: Parameters<ReturnType<typeof createConsumerUpgradeUseCase>>[0] & {
      readonly targetGeneration: 1 | 2;
    }) => Promise<ConsumerUpgradeExecutionV1>;
  }
) {
  // oxlint-disable-next-line complexity
  return async function runManagedConsumerCommand(argv: readonly string[]): Promise<number> {
    let command = "";
    const jsonRequested = requestsJsonOutput(argv);
    let execution: ConsumerExecution;
    try {
      assertBoundedArgv(argv);
      command = argv[0] ?? "";
      if (command === "help" || command === "--help" || argv[1] === "--help") {
        const helpArgs = new Arguments(argv.slice(1));
        if (argv[1] === "--help") {helpArgs.flag("--help");}
        helpArgs.assertConsumed();
        if (jsonRequested) {throw new ConsumerCliInputError("--help does not accept --json.");}
        process.stdout.write(managedDocsHelp());
        return 0;
      }
      const args = new Arguments(argv.slice(1));
      args.flag("--json");
      const consumerRoot = args.one("--consumer") ?? ".";
      if (command === "check") {
        args.assertConsumed();
        execution = await operations.check({ consumerRoot });
      } else if (command === "plan") {
        const to = args.one("--to", true)!;
        if (!COHORT_ID.test(to)) {throw new ConsumerCliInputError("--to must be one exact Cohort ID.");}
        args.assertConsumed();
        execution = await operations.plan({ consumerRoot, to });
      } else if (command === "apply") {
        const expect = args.one("--expect", true)!;
        if (!SHA256.test(expect)) {throw new ConsumerCliInputError("--expect must be one sha256 Plan digest.");}
        args.assertConsumed();
        execution = await operations.apply({ consumerRoot, expect });
      } else if (command === "upgrade") {
        const to = args.one("--to", true)!;
        if (!COHORT_ID.test(to)) {throw new ConsumerCliInputError("--to must be one exact Cohort ID.");}
        const authorityRevision = args.one("--authority-revision");
        if (authorityRevision !== undefined && !GIT_SHA.test(authorityRevision)) {
          throw new ConsumerCliInputError("--authority-revision must be one nonzero lowercase Git SHA.");
        }
        const generation = args.one("--target-generation", true)!;
        if (generation !== "1" && generation !== "2") {
          throw new ConsumerCliInputError("--target-generation must be exactly 1 or 2.");
        }
        args.assertConsumed();
        execution = await operations.upgrade({
          consumerRoot,
          to,
          targetGeneration: Number(generation) as 1 | 2,
          ...(authorityRevision === undefined ? {} : { authorityRevision })
        });
      } else if (command === "recover") {
        args.assertConsumed();
        execution = await operations.recover({ consumerRoot });
      } else {
        throw new ConsumerCliInputError("Expected consumer command: check, plan, apply, upgrade, or recover.");
      }
    } catch (error) {
      execution = failure(command || "check", error);
    }
    try {
      if (execution.command === "consumer.upgrade") {
        await assertConsumerUpgradeExecutionSchema(execution);
      } else {
        await assertConsumerIntegrationExecutionSchema(execution);
      }
    } catch (error) {
      execution = failure(command || "check", error);
    }
    process.stdout.write(jsonRequested ? `${JSON.stringify(execution)}\n` : human(execution));
    return exitCode(execution);
  };
}
