import type {
  ConsumerIntegrationExecutionV1,
  ConsumerRestorationExecution,
  RestorableConsumerUpgradeExecution,
  ManagedConsumerOperations,
} from "../../application-api.js";
import {
  assertConsumerIntegrationExecutionSchema,
  assertConsumerRestorationExecutionSchema,
  assertConsumerUpgradeExecutionSchema,
} from "../consumer-integration-schema-validator.js";

import {
  Arguments,
  ConsumerCliInputError,
  COHORT_ID,
  SHA256,
  GIT_SHA,
  MAXIMUM_ARGUMENT_LENGTH,
  MAXIMUM_ARGUMENTS,
} from "./consumer-cli-arguments.js";
import {
  executeFinalizationArguments,
  executeRestorationArguments,
} from "./consumer-restoration-cli.js";

type ConsumerExecution =
  | ConsumerIntegrationExecutionV1
  | RestorableConsumerUpgradeExecution
  | ConsumerRestorationExecution;

function failure(command: string, error: unknown): ConsumerExecution {
  const candidateCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "DOCS_CONSUMER_EXECUTION_FAILURE";
  const code = /^(?:DOCS_|KNOWN_)[A-Z0-9_]{1,122}$/u.test(candidateCode)
    ? candidateCode
    : "DOCS_CONSUMER_EXECUTION_FAILURE";
  const rawMessage = error instanceof Error ? error.message : "Consumer integration failed.";
  let safeMessage = "";
  // Temporary and store paths can use any mount root, including siblings of TMPDIR.
  // Consume complete HTTP(S) URLs before path alternatives, including query values.
  for (const character of rawMessage.replace(
    /https?:\/\/[^\s'"`]+|(?:[A-Za-z]:\\|\/(?:Users|home|tmp|private|var|Volumes)\/)[^\s'"`]+|(^|[\s('"`=])\/[^\s'"`]+/giu,
    (token, prefix: string | undefined) =>
      /^https?:\/\//iu.test(token) ? token : `${prefix ?? ""}<local-path>`,
  )) {
    const codePoint = character.codePointAt(0) ?? 0;
    safeMessage +=
      (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127 ? "?" : character;
  }
  safeMessage = safeMessage.slice(0, 4096);
  if (command === "upgrade" || command === "finalize" || command === "restore") {
    return {
      schemaVersion: 1,
      command:
        command === "restore"
          ? "consumer.restore"
          : command === "finalize"
            ? "consumer.finalize"
            : "consumer.upgrade",
      outcome: "blocked",
      issues: [{ code, severity: "error", subject: command, message: safeMessage }],
    };
  }
  const commandId = ["apply", "check", "plan", "recover"].includes(command)
    ? (`consumer.${command}` as ConsumerIntegrationExecutionV1["command"])
    : "consumer.check";
  return {
    schemaVersion: 1,
    command: commandId,
    outcome: "blocked",
    issues: [
      {
        code,
        severity: "error",
        subject: command.slice(0, 2048),
        message: safeMessage,
      },
    ],
  };
}

function human(execution: ConsumerExecution): string {
  const lines = [`${execution.command}: ${execution.outcome}`];
  const plan = "plan" in execution ? execution.plan : undefined;
  if (plan !== undefined) {
    lines.push(`Cohort: ${plan.cohortId}`);
    lines.push(`Plan: ${plan.planDigest}`);
    for (const asset of plan.assets) {
      const current = asset.currentDigest === undefined ? "absent" : asset.currentDigest;
      lines.push(`${asset.action.padEnd(7)} ${asset.path} (${asset.ownership}, ${asset.state})`);
      if (asset.action !== "none") {
        lines.push(`        ${current} -> ${asset.expectedDigest}`);
      }
    }
  }
  if (
    (execution.command === "consumer.upgrade" || execution.command === "consumer.finalize") &&
    execution.restoration !== undefined
  ) {
    lines.push(
      `Restoration proof: ${execution.restoration.path}`,
      `Retain digest separately: ${execution.restoration.digest}`,
    );
  }
  if (execution.command === "consumer.upgrade" && execution.preparation !== undefined) {
    lines.push(
      `Prepared intent: ${execution.preparation.path}`,
      `Select before mutation: ${execution.preparation.digest}`,
    );
  }
  if (execution.receipt !== undefined) {
    lines.push(`Receipt: ${execution.receipt.receiptDigest}`);
  }
  for (const issue of execution.issues) {
    lines.push(
      `${issue.severity.toUpperCase()} ${issue.code} [${issue.subject}]: ${issue.message}`,
    );
    lines.push(
      execution.command === "consumer.restore"
        ? "Next: retain the proof, recover active kernel evidence, then use restore --activation-only for exact V1 bytes."
        : execution.command === "consumer.finalize"
          ? "Next: preserve evidence and retry finalize with the retained preparation selection; choose a distinct proof path for partial files."
          : issue.code === "DOCS_CONSUMER_STALE_PLAN"
            ? "Next: run agent-teams-docs-managed plan again and review the new digest."
            : issue.code.includes("RECOVERY") || issue.code.startsWith("KNOWN_FILE")
              ? "Next: run agent-teams-docs-managed recover, then repeat check and plan."
              : "Next: fix the reported authority or conflict, then repeat check and plan.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function exitCode(execution: ConsumerExecution): number {
  if (
    [
      "applied",
      "current",
      "recovered",
      "upgraded",
      "restored",
      "activated-v1",
      "prepared",
    ].includes(execution.outcome)
  ) {
    return 0;
  }
  if (execution.outcome === "change-required") {
    return 1;
  }
  const codes = new Set(execution.issues.map(({ code }) => code));
  if (codes.has("DOCS_CONSUMER_CLI_INVALID")) {
    return 2;
  }
  return codes.has("DOCS_CONSUMER_EXECUTION_FAILURE") ? 3 : 1;
}

function assertBoundedArgv(argv: readonly string[]): void {
  if (
    argv.length > MAXIMUM_ARGUMENTS ||
    argv.some(
      (value) =>
        typeof value !== "string" ||
        value.length > MAXIMUM_ARGUMENT_LENGTH ||
        value.includes("\u0000"),
    )
  ) {
    throw new ConsumerCliInputError(
      "Consumer arguments are invalid or exceed the bounded CLI contract.",
    );
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
  upgrade --to COHORT --target-generation 1|2|3  Project authority, pins, lockfile, and assets
  restore --from V2 --to V1 --source-generation 2 --target-generation 1
          --proof PATH --expect SHA256 [--activation-only]  Restore recorded V1
  finalize --from V1 --to V2 --source-generation 1 --target-generation 2
           --preparation PATH --expect SHA256 --proof PATH  Apply/retry selected migration
  restore --from V3 --to V2 --source-generation 3 --target-generation 2
          --preparation PATH --expect SHA256  Restore the selected original generation2
  finalize --from V2 --to V3 --source-generation 2 --target-generation 3
           --preparation PATH --expect SHA256 --proof PATH  Resume retained controller
  restore ... --current-revision SHA --current-tree SHA --selection PATH
          [--selection-expect SHA256]  Admit/resume rollback from a clean committed target
  recover                       Recover the Foundation transaction (profile not read)

Options:
  --consumer PATH               Git repository root (default: .)
  --authority-revision SHA      Optional exact protected .github revision
  --source-generation 1|2 --restoration-proof PATH --prepare  Stage and select before mutation
  --target-lockfile PATH --target-lockfile-sha256 sha256:HEX  Select exact external lock for 1->2 preparation
  --json                        Emit one bounded versioned JSON envelope
  --help                        Show this help
`;
}

function upgradeAuthorityRevision(args: Arguments): string | undefined {
  const authorityRevision = args.one("--authority-revision");
  if (authorityRevision !== undefined && !GIT_SHA.test(authorityRevision)) {
    throw new ConsumerCliInputError("--authority-revision must be one nonzero lowercase Git SHA.");
  }
  return authorityRevision;
}

async function executeUpgradeArguments(
  args: Arguments,
  consumerRoot: string,
  operations: ManagedConsumerOperations,
): Promise<ConsumerExecution> {
  const to = args.one("--to", true)!;
  if (!COHORT_ID.test(to)) {
    throw new ConsumerCliInputError("--to must be one exact Cohort ID.");
  }
  const authorityRevision = upgradeAuthorityRevision(args);
  const generation = args.one("--target-generation", true)!;
  if (generation !== "1" && generation !== "2" && generation !== "3") {
    throw new ConsumerCliInputError("--target-generation must be exactly 1, 2 or 3.");
  }
  const restorationProofPath = args.one("--restoration-proof");
  const prepare = args.flag("--prepare");
  const targetLockfilePath = args.one("--target-lockfile");
  const targetLockfileSha256 = args.one("--target-lockfile-sha256");
  const sourceGeneration = args.one("--source-generation");
  if (sourceGeneration !== undefined && !["1", "2"].includes(sourceGeneration)) {
    throw new ConsumerCliInputError("Restorable upgrade requires --source-generation 1 or 2.");
  }
  if (targetLockfilePath !== undefined || targetLockfileSha256 !== undefined) {
    if (
      targetLockfilePath === undefined ||
      targetLockfileSha256 === undefined ||
      !SHA256.test(targetLockfileSha256) ||
      !prepare ||
      sourceGeneration !== "1" ||
      generation !== "2" ||
      restorationProofPath === undefined
    ) {
      throw new ConsumerCliInputError(
        "Target lock requires both flags and explicit 1->2 --prepare with --restoration-proof.",
      );
    }
  }
  args.assertConsumed();
  return await operations.upgrade({
    ...(targetLockfilePath === undefined
      ? {}
      : {
          targetLockfile: { path: targetLockfilePath, sha256: targetLockfileSha256! },
        }),
    consumerRoot,
    to,
    targetGeneration: Number(generation) as 1 | 2 | 3,
    prepare,
    ...(sourceGeneration === undefined
      ? {}
      : { sourceGeneration: Number(sourceGeneration) as 1 | 2 }),
    ...(restorationProofPath === undefined ? {} : { restorationProofPath }),
    ...(authorityRevision === undefined ? {} : { authorityRevision }),
  });
}

export function createManagedConsumerCommand(operations: ManagedConsumerOperations) {
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
        if (argv[1] === "--help") {
          helpArgs.flag("--help");
        }
        helpArgs.assertConsumed();
        if (jsonRequested) {
          throw new ConsumerCliInputError("--help does not accept --json.");
        }
        process.stdout.write(managedDocsHelp());
        return 0;
      }
      // Compile the production wire contract before a command can mutate the consumer.
      if (command === "restore") {
        await assertConsumerRestorationExecutionSchema({
          schemaVersion: 1,
          command: "consumer.restore",
          outcome: "blocked",
          issues: [],
        });
      } else if (command === "upgrade" || command === "finalize") {
        await assertConsumerUpgradeExecutionSchema({
          schemaVersion: 1,
          command: "consumer.upgrade",
          outcome: "blocked",
          issues: [],
        });
      }
      const args = new Arguments(argv.slice(1));
      args.flag("--json");
      const consumerRoot = args.one("--consumer") ?? ".";
      if (command === "check") {
        args.assertConsumed();
        execution = await operations.check({ consumerRoot });
      } else if (command === "plan") {
        const to = args.one("--to", true)!;
        if (!COHORT_ID.test(to)) {
          throw new ConsumerCliInputError("--to must be one exact Cohort ID.");
        }
        args.assertConsumed();
        execution = await operations.plan({ consumerRoot, to });
      } else if (command === "apply") {
        const expect = args.one("--expect", true)!;
        if (!SHA256.test(expect)) {
          throw new ConsumerCliInputError("--expect must be one sha256 Plan digest.");
        }
        args.assertConsumed();
        execution = await operations.apply({ consumerRoot, expect });
      } else if (command === "upgrade") {
        execution = await executeUpgradeArguments(args, consumerRoot, operations);
      } else if (command === "finalize") {
        execution = await executeFinalizationArguments(args, consumerRoot, operations);
      } else if (command === "restore") {
        execution = await executeRestorationArguments(args, consumerRoot, operations);
      } else if (command === "recover") {
        args.assertConsumed();
        execution = await operations.recover({ consumerRoot });
      } else {
        throw new ConsumerCliInputError(
          "Expected consumer command: check, plan, apply, upgrade, finalize, restore, or recover.",
        );
      }
    } catch (error) {
      execution = failure(command || "check", error);
    }
    try {
      if (execution.command === "consumer.restore") {
        await assertConsumerRestorationExecutionSchema(execution);
      } else if (
        execution.command === "consumer.upgrade" ||
        execution.command === "consumer.finalize"
      ) {
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
