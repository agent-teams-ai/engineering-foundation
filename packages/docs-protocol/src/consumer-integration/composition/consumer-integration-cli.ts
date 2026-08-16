import {
  applyConsumerIntegration,
  checkConsumerIntegration,
  planNodeConsumerIntegration,
  recoverConsumerIntegration,
  type ConsumerIntegrationExecutionV1
} from "./node-consumer-integration.js";
import { assertConsumerIntegrationExecutionSchema } from "../adapters/consumer-integration-schema-validator.js";

class ConsumerCliInputError extends Error {
  readonly code = "DOCS_CONSUMER_CLI_INVALID";
}

const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
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

function failure(command: string, error: unknown): ConsumerIntegrationExecutionV1 {
  const candidateCode = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : "DOCS_CONSUMER_EXECUTION_FAILURE";
  const code = /^(?:DOCS_|KNOWN_)[A-Z0-9_]{1,122}$/u.test(candidateCode)
    ? candidateCode
    : "DOCS_CONSUMER_EXECUTION_FAILURE";
  const commandId = ["apply", "check", "plan", "recover"].includes(command)
    ? `consumer.${command}` as ConsumerIntegrationExecutionV1["command"]
    : "consumer.check";
  const rawMessage = error instanceof Error ? error.message : "Consumer integration failed.";
  const safeMessage = [...rawMessage
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|private|var|Volumes)\/)[^\s'"`]+/gu, "<local-path>")
  ].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127
      ? "?"
      : character;
  }).join("")
    .slice(0, 4096);
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

function human(execution: ConsumerIntegrationExecutionV1): string {
  const lines = [`${execution.command}: ${execution.outcome}`];
  if (execution.plan !== undefined) {
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
      ? "Next: run consumer plan again and review the new digest."
      : issue.code.includes("RECOVERY") || issue.code.startsWith("KNOWN_FILE")
        ? "Next: run consumer recover, then repeat check and plan."
        : "Next: fix the reported authority or conflict, then repeat check and plan.");
  }
  return `${lines.join("\n")}\n`;
}

function exitCode(execution: ConsumerIntegrationExecutionV1): number {
  if (["applied", "current", "recovered"].includes(execution.outcome)) {return 0;}
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

export function consumerIntegrationHelp(): string {
  return `Usage: agent-teams-docs consumer <command> [options]

Commands:
  check                         Verify the selected Cohort without writing
  plan --to COHORT              Print a deterministic, write-free semantic plan
  apply --expect SHA256         Rebuild and apply the reviewed plan through Foundation
  recover                       Recover the Foundation transaction (profile not read)

Options:
  --consumer PATH               Git repository root (default: .)
  --integration-profile PATH    V1 fixed integration profile path
  --json                        Emit one bounded versioned JSON envelope
  --help                        Show this help
`;
}

// oxlint-disable-next-line complexity -- the bounded command router keeps all CLI variants in one envelope boundary.
export async function runConsumerIntegrationCli(argv: readonly string[]): Promise<number> {
  let command = "";
  let jsonRequested = false;
  let execution: ConsumerIntegrationExecutionV1;
  try {
    assertBoundedArgv(argv);
    command = argv[0] ?? "";
    jsonRequested = argv.includes("--json");
    if (command === "help" || command === "--help" || argv[1] === "--help") {
      const helpArgs = new Arguments(argv.slice(1));
      if (argv[1] === "--help") {helpArgs.flag("--help");}
      helpArgs.assertConsumed();
      process.stdout.write(consumerIntegrationHelp());
      return 0;
    }
    const args = new Arguments(argv.slice(1));
    args.flag("--json");
    const consumerRoot = args.one("--consumer") ?? ".";
    const integrationProfilePath = args.one("--integration-profile");
    if (command === "check") {
      args.assertConsumed();
      execution = await checkConsumerIntegration({
        consumerRoot,
        ...(integrationProfilePath === undefined ? {} : { integrationProfilePath })
      });
    } else if (command === "plan") {
      const to = args.one("--to", true)!;
      if (!COHORT_ID.test(to)) {throw new ConsumerCliInputError("--to must be one exact Cohort ID.");}
      args.assertConsumed();
      execution = await planNodeConsumerIntegration({
        consumerRoot,
        to,
        ...(integrationProfilePath === undefined ? {} : { integrationProfilePath })
      });
    } else if (command === "apply") {
      const expect = args.one("--expect", true)!;
      if (!SHA256.test(expect)) {throw new ConsumerCliInputError("--expect must be one sha256 Plan digest.");}
      args.assertConsumed();
      execution = await applyConsumerIntegration({
        consumerRoot,
        expect,
        ...(integrationProfilePath === undefined ? {} : { integrationProfilePath })
      });
    } else if (command === "recover") {
      if (integrationProfilePath !== undefined) {
        throw new ConsumerCliInputError("consumer recover does not read an integration profile.");
      }
      args.assertConsumed();
      execution = await recoverConsumerIntegration({ consumerRoot });
    } else {
      throw new ConsumerCliInputError("Expected consumer command: check, plan, apply, or recover.");
    }
  } catch (error) {
    execution = failure(command || "check", error);
  }
  try {
    await assertConsumerIntegrationExecutionSchema(execution);
  } catch (error) {
    execution = failure(command || "check", error);
  }
  process.stdout.write(jsonRequested ? `${JSON.stringify(execution)}\n` : human(execution));
  return exitCode(execution);
}
