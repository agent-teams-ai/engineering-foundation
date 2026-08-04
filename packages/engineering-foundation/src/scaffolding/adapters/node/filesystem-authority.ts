import type {
  AuthorityScaffoldJournal,
  AuthorityScaffoldOperationReceipt,
  AuthorityScaffoldPlan,
  AuthorityScaffoldReceipt
} from "../../contract/types.js";
import { assessScaffoldPlanAuthority } from "./node-plan-authority.js";
import { assertSafeExistingAncestors } from "./filesystem-path-guard.js";
import { classifyFilesystemOperation } from "./filesystem-operation-state.js";
import { createRecoveryRequiredReceipt } from "./filesystem-journal-state.js";

export function recoveryRequiredForAuthority(options: {
  readonly plan: AuthorityScaffoldPlan;
  readonly phase: "apply" | "recovery";
  readonly ruleId: string;
  readonly message: string;
  readonly remediation: string;
  readonly operations?: readonly AuthorityScaffoldOperationReceipt[];
}): AuthorityScaffoldReceipt {
  return createRecoveryRequiredReceipt({
    plan: options.plan,
    phase: options.phase,
    ruleId: options.ruleId,
    subject: options.plan.projectId,
    message: options.message,
    remediation: options.remediation,
    ...(options.operations === undefined ? {} : { operations: options.operations })
  });
}

export async function safeClassifyPlan(
  root: string,
  plan: AuthorityScaffoldPlan
): Promise<
  readonly {
    readonly operation: AuthorityScaffoldPlan["operations"][number];
    readonly state: "absent" | "after" | "conflict";
  }[]
> {
  const classifications = [] as {
    operation: AuthorityScaffoldPlan["operations"][number];
    state: "absent" | "after" | "conflict";
  }[];
  for (const operation of plan.operations) {
    await assertSafeExistingAncestors(root, operation.path);
    classifications.push({
      operation,
      state: await classifyFilesystemOperation(root, operation)
    });
  }
  return classifications;
}

export async function resolveAuthority(options: {
  readonly root: string;
  readonly journal: AuthorityScaffoldJournal;
  readonly recovered: boolean;
  readonly observedOperations?: readonly AuthorityScaffoldOperationReceipt[];
}): Promise<AuthorityScaffoldReceipt | undefined> {
  const assessment = await assessScaffoldPlanAuthority(
    options.root,
    options.journal.plan
  );
  if (assessment.state === "current") {
    return undefined;
  }
  if (assessment.state === "unverifiable") {
    return recoveryRequiredForAuthority({
      plan: options.journal.plan,
      phase: options.recovered ? "recovery" : "apply",
      ruleId: "scaffolding.authority.unverifiable",
      message:
        "Authority cannot be re-verified safely after publication began; outputs and journal were preserved.",
      remediation: "Restore readable authority sources, then retry recovery.",
      ...(options.observedOperations === undefined
        ? {}
        : { operations: options.observedOperations })
    });
  }
  return recoveryRequiredForAuthority({
    plan: options.journal.plan,
    phase: options.recovered ? "recovery" : "apply",
    ruleId: "scaffolding.authority.stale-after-publication",
    message:
      "Authority changed after publication began; outputs and journal were preserved because portable file ownership cannot be proven.",
    remediation: "Resolve the transaction state explicitly, then compile a new Plan.",
    ...(options.observedOperations === undefined
      ? {}
      : { operations: options.observedOperations })
  });
}
