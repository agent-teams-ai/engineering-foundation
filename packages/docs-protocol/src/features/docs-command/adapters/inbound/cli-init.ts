import type { DocsInitApi } from "../../application/command-operations.js";
import { Arguments, CliInputError } from "./cli-input.js";
import { directExecution } from "./docs-cli-machine.js";

function assertInitPlanArguments(input: {
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly expectedPlanDigest: string | undefined;
  readonly ownerId: string | undefined;
  readonly projectId: string | undefined;
}): asserts input is typeof input & {
  readonly ownerId: string;
  readonly projectId: string;
} {
  if (input.dryRun === input.apply) {
    throw new CliInputError("Exactly one of --dry-run or --apply is required.");
  }
  if (input.projectId === undefined) {
    throw new CliInputError("--project-id is required.");
  }
  if (input.ownerId === undefined) {
    throw new CliInputError("--owner is required.");
  }
  if (input.dryRun && input.expectedPlanDigest !== undefined) {
    throw new CliInputError("--expect is valid only with --apply.");
  }
  if (input.apply && input.expectedPlanDigest === undefined) {
    throw new CliInputError("--apply requires the exact --expect digest returned by --dry-run.");
  }
}

export async function dispatchInit(args: Arguments, signal: AbortSignal, bootstrap: DocsInitApi) {
  const consumerRoot = args.one("--consumer") ?? ".";
  const json = args.flag("--json");
  const recover = args.flag("--recover");
  const dryRun = args.flag("--dry-run");
  const apply = args.flag("--apply");
  const projectId = args.one("--project-id");
  const ownerId = args.one("--owner");
  const expectedPlanDigest = args.one("--expect");
  if (args.positionals().length !== 0) {
    throw new CliInputError("Unknown docs:init arguments.");
  }
  signal.throwIfAborted();
  if (recover) {
    if (
      dryRun ||
      apply ||
      projectId !== undefined ||
      ownerId !== undefined ||
      expectedPlanDigest !== undefined
    ) {
      throw new CliInputError("--recover cannot be combined with bootstrap planning arguments.");
    }
    return dispatchInitRecovery(consumerRoot, json, bootstrap);
  }
  const planArguments = { apply, dryRun, expectedPlanDigest, ownerId, projectId };
  assertInitPlanArguments(planArguments);
  if (apply) {
    const barrier = await bootstrap.docsInitApplyPreflight({ consumerRoot });
    if (barrier !== undefined) {
      return dispatchInitBarrier(barrier, json);
    }
  }
  const plan = await bootstrap.docsInitPlan({
    consumerRoot,
    projectId: planArguments.projectId,
    ownerId: planArguments.ownerId,
  });
  if (plan.writeState === "blocked") {
    return {
      json,
      execution: directExecution(
        "docs.init",
        "conflict",
        plan,
        plan.issues.map((issue) => ({
          ruleId: "docs.init.bootstrap-conflict",
          severity: "error" as const,
          phase: "planning" as const,
          subject: issue.path,
          message: issue.message,
        })),
      ),
    };
  }
  if (!apply) {
    return { json, execution: directExecution("docs.init", "success", plan) };
  }
  if (planArguments.expectedPlanDigest !== plan.planDigest) {
    return {
      json,
      execution: directExecution("docs.init", "authority-stale", plan, [
        {
          ruleId: "docs.init.plan-stale",
          severity: "error",
          phase: "planning",
          subject: "--expect",
          message: "Portable bootstrap authority changed after preview; review a fresh dry run.",
        },
      ]),
    };
  }
  const applied = await bootstrap.docsInitApply({
    consumerRoot,
    projectId: planArguments.projectId,
    ownerId: planArguments.ownerId,
    expectedPlanDigest: plan.planDigest,
  });
  if (applied.writeState === "blocked") {
    return dispatchInitBarrier(applied, json);
  }
  return {
    json,
    execution: directExecution("docs.init", "success", applied),
  };
}

function dispatchInitBarrier(
  barrier:
    | {
        readonly kind: "init";
        readonly operation: "recover";
        readonly writeState: "blocked";
        readonly message: string;
      }
    | {
        readonly kind: "init";
        readonly operation: "wait";
        readonly writeState: "blocked";
        readonly reason: "operation-active";
        readonly message: string;
      },
  json: boolean,
) {
  if (barrier.operation === "wait") {
    return {
      json,
      execution: directExecution(
        "docs.init",
        "conflict",
        Object.freeze({
          kind: barrier.kind,
          operation: barrier.operation,
          writeState: barrier.writeState,
          reason: barrier.reason,
        }),
        [
          {
            ruleId: "docs.init.operation-active",
            severity: "error",
            phase: "planning",
            subject: "foundation.operation",
            message: barrier.message,
          },
        ],
      ),
    };
  }
  return {
    json,
    execution: directExecution(
      "docs.init",
      "recovery-required",
      Object.freeze({
        kind: barrier.kind,
        operation: barrier.operation,
        writeState: barrier.writeState,
      }),
      [
        {
          ruleId: "docs.init.apply-recovery-required",
          severity: "error",
          phase: "recovery",
          subject: "foundation.transaction",
          message: barrier.message,
        },
      ],
    ),
  };
}

async function dispatchInitRecovery(consumerRoot: string, json: boolean, bootstrap: DocsInitApi) {
  const recovery = await bootstrap.docsInitRecover({ consumerRoot });
  if (recovery.writeState === "unchanged") {
    return { json, execution: directExecution("docs.init", "success", recovery) };
  }
  if (recovery.writeState === "blocked") {
    if (recovery.operation === "wait") {
      return dispatchInitBarrier(recovery, json);
    }
    return {
      json,
      execution: directExecution(
        "docs.init",
        "recovery-required",
        Object.freeze({
          kind: recovery.kind,
          operation: recovery.operation,
          writeState: recovery.writeState,
        }),
        [
          {
            ruleId: "docs.init.recovery-blocked",
            severity: "error",
            phase: "recovery",
            subject: "foundation.transaction",
            message: recovery.message,
          },
        ],
      ),
    };
  }
  return { json, execution: directExecution("docs.init", "success", recovery) };
}
