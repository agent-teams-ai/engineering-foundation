import type {
  JsonValue,
  ScaffoldDiagnosticV1,
  AuthorityScaffoldOperationOutcome,
  AuthorityScaffoldOperationReceipt,
  AuthorityScaffoldPlan,
  AuthorityScaffoldReceiptOutcome,
  AuthorityScaffoldReceipt
} from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import { sha256Json } from "./canonical-json.js";
import { assertAuthorityScaffoldPlanDigest } from "./plan-validation.js";

interface AuthorityScaffoldReceiptCandidate {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly planDigest: string;
  readonly adapter: {
    readonly id: string;
    readonly contractVersion: number;
  };
  readonly outcome: string;
  readonly commit: {
    readonly state: string;
    readonly atomicity: string;
  };
  readonly operations: readonly AuthorityScaffoldOperationReceipt[];
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly receiptDigest: string;
}

export interface CreateAuthorityScaffoldReceiptOptions {
  readonly plan: AuthorityScaffoldPlan;
  readonly outcome: AuthorityScaffoldReceiptOutcome;
  readonly commitState:
    | "committed"
    | "recovered"
    | "recovery-required"
    | "rejected"
    | "rolled-back";
  readonly operations: readonly AuthorityScaffoldOperationReceipt[];
  readonly diagnostics?: readonly ScaffoldDiagnosticV1[];
}

const SHA_256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function invalidReceipt(message: string): never {
  throw new ScaffoldError("SCAFFOLD_RECEIPT_INVALID", message);
}

function hasObservedPostImage(outcome: AuthorityScaffoldOperationOutcome): boolean {
  return (
    outcome === "already-satisfied" ||
    outcome === "applied" ||
    outcome === "recovered"
  );
}

function assertDigest(value: string | undefined, subject: string): void {
  if (value === undefined || !SHA_256_DIGEST_PATTERN.test(value)) {
    invalidReceipt(`${subject} must be a SHA-256 digest.`);
  }
}

function assertAdapterAndCommit(receipt: AuthorityScaffoldReceiptCandidate): void {
  if (receipt.adapter.id !== "foundation.filesystem/v1") {
    invalidReceipt("Scaffolding Receipt adapter is not supported by current scaffolding protocol.");
  }
  if (receipt.adapter.contractVersion !== 1) {
    invalidReceipt("Scaffolding Receipt adapter contract version is not supported.");
  }
  if (receipt.commit.atomicity !== "journaled-recoverable") {
    invalidReceipt("Scaffolding Receipt adapter and commit atomicity are incompatible.");
  }
  const expectedState = (() => {
    switch (receipt.outcome) {
      case "applied":
      case "already-applied":
        return "committed";
      case "failed-recovered":
        return "recovered";
      case "recovery-required":
        return "recovery-required";
      case "rejected":
        return "rejected";
      case "authority-stale":
        return "rolled-back";
      default:
        return invalidReceipt("Scaffolding Receipt outcome is not supported by current scaffolding protocol.");
    }
  })();
  if (receipt.commit.state !== expectedState) {
    invalidReceipt("Scaffolding Receipt outcome and commit state are incompatible.");
  }
}

function assertOperations(receipt: AuthorityScaffoldReceiptCandidate): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const operation of receipt.operations) {
    if (ids.has(operation.operationId) || paths.has(operation.path)) {
      invalidReceipt(`Scaffolding Receipt operation evidence is duplicated: ${operation.operationId}.`);
    }
    ids.add(operation.operationId);
    paths.add(operation.path);
    if (hasObservedPostImage(operation.outcome)) {
      assertDigest(operation.resultDigest, `Scaffolding Receipt operation ${operation.operationId} result`);
    } else if (operation.resultDigest !== undefined) {
      invalidReceipt(`Scaffolding Receipt operation claims an unobserved result: ${operation.operationId}.`);
    }
  }
}

function assertOnly(
  operations: readonly AuthorityScaffoldOperationReceipt[],
  allowed: readonly AuthorityScaffoldOperationOutcome[],
  required?: readonly AuthorityScaffoldOperationOutcome[]
): void {
  if (operations.some((operation) => !allowed.includes(operation.outcome))) {
    invalidReceipt("Scaffolding Receipt operation outcome is incompatible with its Receipt outcome.");
  }
  if (
    required !== undefined &&
    !operations.some((operation) => required.includes(operation.outcome))
  ) {
    invalidReceipt("Scaffolding Receipt does not contain the required operation evidence.");
  }
}

function assertOutcome(receipt: AuthorityScaffoldReceiptCandidate): void {
  switch (receipt.outcome) {
    case "applied":
      if (receipt.operations.length === 0) {
        invalidReceipt("An applied Scaffolding Receipt requires operation evidence.");
      }
      if (receipt.operations[0]?.outcome !== "applied") {
        invalidReceipt("An applied Scaffolding Receipt must place applied evidence first.");
      }
      assertOnly(receipt.operations, ["already-satisfied", "applied"], ["applied"]);
      return;
    case "already-applied":
      if (receipt.operations.length === 0) {
        invalidReceipt("An already-applied Scaffolding Receipt requires operation evidence.");
      }
      assertOnly(receipt.operations, ["already-satisfied"]);
      return;
    case "failed-recovered":
      if (receipt.operations.length === 0) {
        invalidReceipt("A failed-recovered Scaffolding Receipt requires operation evidence.");
      }
      assertOnly(receipt.operations, ["already-satisfied", "recovered"]);
      return;
    case "recovery-required":
      if (receipt.operations.length === 0) {
        invalidReceipt("A recovery-required Scaffolding Receipt requires operation evidence.");
      }
      assertOnly(
        receipt.operations,
        ["already-satisfied", "conflict", "not-applied", "unobserved"]
      );
      return;
    case "authority-stale":
      if (receipt.operations.length === 0) {
        invalidReceipt("An authority-stale Scaffolding Receipt requires operation evidence.");
      }
      assertOnly(receipt.operations, ["not-applied"]);
      return;
    case "rejected":
      assertOnly(receipt.operations, ["already-satisfied", "conflict", "not-applied"]);
      return;
    default:
      invalidReceipt("Scaffolding Receipt outcome is not supported by current scaffolding protocol.");
  }
}

function assertPlanEvidence(
  receipt: AuthorityScaffoldReceiptCandidate,
  plan: AuthorityScaffoldPlan
): void {
  assertAuthorityScaffoldPlanDigest(plan);
  if (receipt.planDigest !== plan.planDigest) {
    invalidReceipt("Scaffolding Receipt references a different Plan digest.");
  }
  const operations = new Map(plan.operations.map((operation) => [operation.id, operation]));
  for (const operation of receipt.operations) {
    const planned = operations.get(operation.operationId);
    if (planned === undefined || planned.path !== operation.path) {
      invalidReceipt(`Scaffolding Receipt operation does not match its Plan evidence: ${operation.operationId}.`);
    }
    if (hasObservedPostImage(operation.outcome) && operation.resultDigest !== planned.after.digest) {
      invalidReceipt(`Scaffolding Receipt result digest does not match its Plan evidence: ${operation.operationId}.`);
    }
  }
  if (
    ["applied", "already-applied", "failed-recovered", "authority-stale"].includes(receipt.outcome) &&
    receipt.operations.length !== plan.operations.length
  ) {
    invalidReceipt("A completed Scaffolding Receipt must provide evidence for every Plan operation.");
  }
}

export function assertAuthorityScaffoldReceiptDigest(
  receipt: AuthorityScaffoldReceipt,
  plan?: AuthorityScaffoldPlan
): void {
  const candidate = receipt as unknown as AuthorityScaffoldReceiptCandidate;
  if (candidate.schemaVersion !== 2 || candidate.protocolVersion !== 2) {
    invalidReceipt("Scaffolding Receipt does not use current scaffolding protocol.");
  }
  assertDigest(candidate.planDigest, "Scaffolding Receipt Plan digest");
  assertAdapterAndCommit(candidate);
  assertOperations(candidate);
  assertOutcome(candidate);
  const { receiptDigest: _receiptDigest, ...body } = candidate;
  if (candidate.receiptDigest !== sha256Json(body as unknown as JsonValue)) {
    invalidReceipt("Scaffolding Receipt digest does not match its canonical content.");
  }
  if (plan !== undefined) {
    assertPlanEvidence(candidate, plan);
  }
}

export function createAuthorityScaffoldReceipt(
  options: CreateAuthorityScaffoldReceiptOptions
): AuthorityScaffoldReceipt {
  const operations =
    options.outcome === "applied"
      ? [...options.operations].toSorted((left, right) =>
          left.outcome === "applied"
            ? right.outcome === "applied"
              ? 0
              : -1
            : right.outcome === "applied"
              ? 1
              : 0
        )
      : [...options.operations];
  const body = {
    schemaVersion: 2 as const,
    protocolVersion: 2 as const,
    planDigest: options.plan.planDigest,
    adapter: Object.freeze({
      id: "foundation.filesystem/v1" as const,
      contractVersion: 1 as const
    }),
    outcome: options.outcome,
    commit: Object.freeze({
      state: options.commitState,
      atomicity: "journaled-recoverable" as const
    }),
    operations: Object.freeze(operations),
    diagnostics: Object.freeze([...(options.diagnostics ?? [])])
  };
  const receipt = Object.freeze({
    ...body,
    receiptDigest: sha256Json(body as unknown as JsonValue)
  }) as AuthorityScaffoldReceipt;
  assertAuthorityScaffoldReceiptDigest(receipt, options.plan);
  return receipt;
}
