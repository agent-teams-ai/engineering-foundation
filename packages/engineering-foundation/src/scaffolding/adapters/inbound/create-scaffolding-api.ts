import type {
  ScaffoldAuthorityEvidence,
  ScaffoldPlan,
  ScaffoldRecoveryScope,
  ScaffoldReceipt
} from "../../contract/scaffold-contract.js";
import {
  assertScaffoldAuthorityEvidenceDigest as assertAuthorityEvidenceDigest
} from "../../kernel/authority-evidence.js";
import { assertAuthorityScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { assertAuthorityScaffoldReceiptDigest } from "./authority-scaffold-receipt.js";
import { snapshotAuthorityScaffoldRecoveryScope } from "../../kernel/recovery-scope.js";
import { ScaffoldError } from "../../scaffold-error.js";

export interface ScaffoldingOperations {
  readonly planScaffoldFromFile: (options: {
    readonly consumerRoot: string;
    readonly intentPath: string;
    readonly configPath?: string;
  }) => Promise<ScaffoldPlan>;
  readonly applyFilesystemScaffold: (consumerRoot: string, plan: ScaffoldPlan) => Promise<ScaffoldReceipt>;
  readonly recoverFilesystemScaffold: (consumerRoot: string, scope?: ScaffoldRecoveryScope) => Promise<ScaffoldReceipt | undefined>;
  readonly readScaffoldPlanFile: (consumerRoot: string, planPath: string) => Promise<ScaffoldPlan>;
  readonly validateScaffoldReceipt: (receipt: unknown, plan?: ScaffoldPlan) => Promise<ScaffoldReceipt>;
}

export type ScaffoldingApi = ReturnType<typeof createScaffoldingApi>;

function assertScaffoldPlanDigest(plan: ScaffoldPlan): void {
  assertAuthorityScaffoldPlanDigest(plan);
}

function assertScaffoldReceiptDigest(
  receipt: ScaffoldReceipt,
  plan?: ScaffoldPlan
): void {
  assertAuthorityScaffoldReceiptDigest(receipt, plan);
}

function assertScaffoldAuthorityEvidenceDigest(
  evidence: ScaffoldAuthorityEvidence
): void {
  assertAuthorityEvidenceDigest(evidence);
}

/** Validates the public recovery boundary before delegating filesystem effects. */
export function createScaffoldingApi(operations: ScaffoldingOperations) {
  async function planScaffoldFromFile(options: {
    readonly consumerRoot: string;
    readonly intentPath: string;
    readonly configPath?: string;
  }): Promise<ScaffoldPlan> {
    return operations.planScaffoldFromFile(options);
  }

  async function applyFilesystemScaffold(
    consumerRoot: string,
    plan: ScaffoldPlan
  ): Promise<ScaffoldReceipt> {
    return operations.applyFilesystemScaffold(consumerRoot, plan);
  }

  async function recoverFilesystemScaffold(
    consumerRoot: string,
    ...scopeArgument: readonly [] | readonly [scope: ScaffoldRecoveryScope]
  ): Promise<ScaffoldReceipt | undefined> {
    if (scopeArgument.length > 1) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        "Scaffolding recovery accepts at most one recovery scope."
      );
    }
    const snapshot = scopeArgument.length === 0
      ? undefined
      : snapshotAuthorityScaffoldRecoveryScope(scopeArgument[0]);
    return operations.recoverFilesystemScaffold(consumerRoot, snapshot);
  }

  async function readScaffoldPlanFile(
    consumerRoot: string,
    planPath: string
  ): Promise<ScaffoldPlan> {
    return operations.readScaffoldPlanFile(consumerRoot, planPath);
  }

  async function validateScaffoldReceipt(
    receipt: unknown,
    plan?: ScaffoldPlan
  ): Promise<ScaffoldReceipt> {
    return operations.validateScaffoldReceipt(receipt, plan);
  }

  return Object.freeze({
    planScaffoldFromFile,
    applyFilesystemScaffold,
    recoverFilesystemScaffold,
    readScaffoldPlanFile,
    validateScaffoldReceipt,
    assertScaffoldPlanDigest,
    assertScaffoldReceiptDigest,
    assertScaffoldAuthorityEvidenceDigest
  });
}
