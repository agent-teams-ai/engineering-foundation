import type {
  ScaffoldDiagnosticV1,
  AuthorityScaffoldJournalOperation,
  AuthorityScaffoldJournal,
  AuthorityScaffoldOperationReceipt,
  AuthorityScaffoldPlan,
  AuthorityScaffoldReceipt
} from "../../contract/types.js";
import { createAuthorityScaffoldReceipt } from "../../kernel/authority-receipt.js";
import { assertSafeExistingAncestors } from "./filesystem-path-guard.js";
import { classifyFilesystemOperation } from "./filesystem-operation-state.js";

export function createAuthorityDiagnostic(
  ruleId: string,
  phase: ScaffoldDiagnosticV1["phase"],
  subject: string,
  message: string,
  remediation: string
): ScaffoldDiagnosticV1 {
  return Object.freeze({
    ruleId,
    severity: "error" as const,
    phase,
    subject,
    message,
    remediation
  });
}

export function receiptFromJournalStates(options: {
  readonly plan: AuthorityScaffoldPlan;
  readonly journal: AuthorityScaffoldJournal;
  readonly outcome: "recovery-required" | "rejected";
  readonly phase: "apply" | "recovery";
  readonly conflictOperationIds: ReadonlySet<string>;
}): AuthorityScaffoldReceipt {
  return createAuthorityScaffoldReceipt({
    plan: options.plan,
    outcome: options.outcome,
    commitState:
      options.outcome === "recovery-required" ? "recovery-required" : "rejected",
    operations: options.plan.operations.map((operation) => {
      const journalOperation = options.journal.operations.find(
        (candidate) => candidate.operationId === operation.id
      );
      if (options.conflictOperationIds.has(operation.id)) {
        return { operationId: operation.id, path: operation.path, outcome: "conflict" };
      }
      if (
        journalOperation?.state === "preexisting" ||
        journalOperation?.state === "published"
      ) {
        return {
          operationId: operation.id,
          path: operation.path,
          outcome: "already-satisfied",
          resultDigest: operation.after.digest
        };
      }
      return {
        operationId: operation.id,
        path: operation.path,
        outcome:
          journalOperation?.state === "publishing" ? "unobserved" : "not-applied"
      };
    }),
    diagnostics: [
      createAuthorityDiagnostic(
        options.phase === "recovery"
          ? "scaffolding.recovery.third-state"
          : "scaffolding.apply.precondition-conflict",
        options.phase,
        options.plan.target.path,
        "Scaffolding output cannot be proven safe for the requested transaction state.",
        options.phase === "recovery"
          ? "Resolve the output manually, then retry recovery."
          : "Compile a new Plan from the current workspace state."
      )
    ]
  });
}

export function createRecoveryRequiredReceipt(options: {
  readonly plan: AuthorityScaffoldPlan;
  readonly phase: "apply" | "recovery";
  readonly ruleId: string;
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
  readonly operations?: readonly AuthorityScaffoldOperationReceipt[];
}): AuthorityScaffoldReceipt {
  return createAuthorityScaffoldReceipt({
    plan: options.plan,
    outcome: "recovery-required",
    commitState: "recovery-required",
    operations:
      options.operations ??
      options.plan.operations.map((operation) => ({
        operationId: operation.id,
        path: operation.path,
        outcome: "unobserved"
      })),
    diagnostics: [
      createAuthorityDiagnostic(
        options.ruleId,
        options.phase,
        options.subject,
        options.message,
        options.remediation
      )
    ]
  });
}

export function freshAuthorityScaffoldJournal(plan: AuthorityScaffoldPlan): AuthorityScaffoldJournal {
  return Object.freeze({
    schemaVersion: 1,
    state: "PREPARED",
    plan,
    operations: Object.freeze(
      plan.operations.map((operation) =>
        Object.freeze({
          operationId: operation.id,
          path: operation.path,
          state: "pending" as const
        })
      )
    )
  });
}

export function replaceScaffoldJournalOperation(
  journal: AuthorityScaffoldJournal,
  operationId: string,
  state: AuthorityScaffoldJournalOperation["state"]
): AuthorityScaffoldJournal {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(
      journal.operations.map((operation) =>
        operation.operationId === operationId
          ? Object.freeze({ ...operation, state })
          : operation
      )
    )
  });
}

export async function reconcileAuthorityScaffoldJournal(
  root: string,
  journal: AuthorityScaffoldJournal
): Promise<{
  readonly journal: AuthorityScaffoldJournal;
  readonly conflictIds: ReadonlySet<string>;
}> {
  let next = journal;
  const conflictIds = new Set<string>();
  for (const operation of journal.plan.operations) {
    const recorded = next.operations.find(
      (candidate) => candidate.operationId === operation.id
    );
    if (recorded === undefined) {
      conflictIds.add(operation.id);
      continue;
    }
    await assertSafeExistingAncestors(root, operation.path);
    const state = await classifyFilesystemOperation(root, operation);
    if (state === "conflict") {
      conflictIds.add(operation.id);
      continue;
    }
    if (recorded.state === "preexisting") {
      if (state === "absent") {
        next = replaceScaffoldJournalOperation(next, operation.id, "pending");
      }
      continue;
    }
    if (recorded.state === "pending" && state === "after") {
      next = replaceScaffoldJournalOperation(next, operation.id, "preexisting");
      continue;
    }
    if (recorded.state === "publishing") {
      next = replaceScaffoldJournalOperation(
        next,
        operation.id,
        state === "after" ? "published" : "pending"
      );
      continue;
    }
    if (recorded.state === "published" && state === "absent") {
      conflictIds.add(operation.id);
    }
  }
  return { journal: next, conflictIds };
}
