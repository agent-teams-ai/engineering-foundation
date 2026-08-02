import type {
  JsonValue,
  ScaffoldDiagnosticV1,
  ScaffoldOperationOutcome,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReceiptOutcome,
  ScaffoldReceiptV1
} from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import { sha256Json } from "./canonical-json.js";
import { assertScaffoldPlanDigest } from "./plan-validation.js";

interface ScaffoldReceiptCandidateV1 {
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly planDigest: string;
  readonly adapter: {
    readonly id: string;
    readonly contractVersion: number;
  };
  readonly outcome: string;
  readonly commit: {
    readonly state:
      | "committed"
      | "recovered"
      | "recovery-required"
      | "rejected";
    readonly atomicity: "journaled-recoverable" | "memory-atomic";
  };
  readonly operations: readonly ScaffoldOperationReceiptV1[];
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly receiptDigest: string;
}

interface CreateScaffoldReceiptOptions {
  readonly plan: ScaffoldPlanV1;
  readonly adapterId:
    | "foundation.filesystem/v1"
    | "foundation.memory/v1";
  readonly outcome: ScaffoldReceiptOutcome;
  readonly commitState: ScaffoldReceiptCandidateV1["commit"]["state"];
  readonly atomicity: ScaffoldReceiptCandidateV1["commit"]["atomicity"];
  readonly operations: readonly ScaffoldOperationReceiptV1[];
  readonly diagnostics?: readonly ScaffoldDiagnosticV1[];
}

const SHA_256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function invalidReceipt(message: string): never {
  throw new ScaffoldError("SCAFFOLD_RECEIPT_INVALID", message);
}

function isSha256Digest(value: string | undefined): boolean {
  return value !== undefined && SHA_256_DIGEST_PATTERN.test(value);
}

function hasObservedPostImage(outcome: ScaffoldOperationOutcome): boolean {
  return (
    outcome === "already-satisfied" ||
    outcome === "applied" ||
    outcome === "recovered"
  );
}

function assertOperationOutcomes(
  receipt: ScaffoldReceiptCandidateV1,
  allowed: readonly ScaffoldOperationOutcome[],
  required?: ScaffoldOperationOutcome
): void {
  if (
    receipt.operations.some(
      (operation) => !allowed.includes(operation.outcome)
    )
  ) {
    invalidReceipt(
      "Scaffolding Receipt operation outcome is incompatible with its Receipt outcome."
    );
  }
  if (
    required !== undefined &&
    !receipt.operations.some((operation) => operation.outcome === required)
  ) {
    invalidReceipt(
      "Scaffolding Receipt does not contain the required operation evidence."
    );
  }
}

function assertReceiptVersionContract(receipt: ScaffoldReceiptCandidateV1): void {
  if (receipt.schemaVersion !== 1 || receipt.protocolVersion !== 1) {
    invalidReceipt("Scaffolding Receipt does not use protocol v1.");
  }
}

function assertReceiptDigestShape(receipt: ScaffoldReceiptCandidateV1): void {
  if (!isSha256Digest(receipt.planDigest)) {
    invalidReceipt("Scaffolding Receipt Plan digest is invalid.");
  }
}

function assertAdapterAndCommitContract(
  receipt: ScaffoldReceiptCandidateV1
): void {
  if (receipt.adapter.contractVersion !== 1) {
    invalidReceipt("Scaffolding Receipt adapter contract version is not supported.");
  }
  const expectedAtomicity =
    receipt.adapter.id === "foundation.filesystem/v1"
      ? "journaled-recoverable"
      : receipt.adapter.id === "foundation.memory/v1"
        ? "memory-atomic"
        : invalidReceipt("Scaffolding Receipt adapter is not supported by protocol v1.");
  const filesystemAdapter = receipt.adapter.id === "foundation.filesystem/v1";
  if (receipt.commit.atomicity !== expectedAtomicity) {
    invalidReceipt(
      "Scaffolding Receipt adapter and commit atomicity are incompatible."
    );
  }

  const expectedCommitState = (() => {
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
      default:
        return invalidReceipt(
          "Scaffolding Receipt outcome is not supported by protocol v1."
        );
    }
  })();
  if (receipt.commit.state !== expectedCommitState) {
    invalidReceipt(
      "Scaffolding Receipt outcome and commit state are incompatible."
    );
  }
  if (
    !filesystemAdapter &&
    (receipt.outcome === "failed-recovered" ||
      receipt.outcome === "recovery-required")
  ) {
    invalidReceipt(
      "Scaffolding Receipt outcome requires a journaled filesystem adapter."
    );
  }
}

function assertReceiptOperationEvidence(receipt: ScaffoldReceiptCandidateV1): void {
  const operationIds = new Set<string>();
  const operationPaths = new Set<string>();
  for (const operation of receipt.operations) {
    if (
      operationIds.has(operation.operationId) ||
      operationPaths.has(operation.path)
    ) {
      invalidReceipt(
        `Scaffolding Receipt operation evidence is duplicated: ${operation.operationId}.`
      );
    }
    operationIds.add(operation.operationId);
    operationPaths.add(operation.path);
    if (hasObservedPostImage(operation.outcome)) {
      if (!isSha256Digest(operation.resultDigest)) {
        invalidReceipt(
          `Scaffolding Receipt operation lacks a result digest: ${operation.operationId}.`
        );
      }
    } else if (operation.resultDigest !== undefined) {
      invalidReceipt(
        `Scaffolding Receipt operation claims an unobserved result: ${operation.operationId}.`
      );
    }
  }
}

function assertReceiptOutcomeEvidence(receipt: ScaffoldReceiptCandidateV1): void {
  switch (receipt.outcome) {
    case "applied":
      if (receipt.operations.length === 0) {
        invalidReceipt("An applied Scaffolding Receipt requires operation evidence.");
      }
      assertOperationOutcomes(receipt, ["already-satisfied", "applied"], "applied");
      break;
    case "already-applied":
      if (receipt.operations.length === 0) {
        invalidReceipt(
          "An already-applied Scaffolding Receipt requires operation evidence."
        );
      }
      assertOperationOutcomes(receipt, ["already-satisfied"]);
      break;
    case "failed-recovered":
      if (receipt.operations.length === 0) {
        invalidReceipt(
          "A failed-recovered Scaffolding Receipt requires operation evidence."
        );
      }
      assertOperationOutcomes(receipt, ["already-satisfied", "recovered"]);
      break;
    case "recovery-required":
      assertOperationOutcomes(receipt, [
        "already-satisfied",
        "conflict",
        "not-applied"
      ]);
      if (
        !receipt.operations.some(
          (operation) =>
            operation.outcome === "conflict" ||
            operation.outcome === "not-applied"
        )
      ) {
        invalidReceipt(
          "A recovery-required Scaffolding Receipt requires unresolved operation evidence."
        );
      }
      break;
    case "rejected":
      assertOperationOutcomes(receipt, [
        "already-satisfied",
        "conflict",
        "not-applied"
      ]);
      break;
    default:
      invalidReceipt("Scaffolding Receipt outcome is not supported by protocol v1.");
  }
}

function assertReceiptContract(receipt: ScaffoldReceiptCandidateV1): void {
  assertReceiptVersionContract(receipt);
  assertReceiptDigestShape(receipt);
  assertAdapterAndCommitContract(receipt);
  assertReceiptOperationEvidence(receipt);
  assertReceiptOutcomeEvidence(receipt);
}

function assertPlanEvidence(
  receipt: ScaffoldReceiptCandidateV1,
  plan: ScaffoldPlanV1
): void {
  assertScaffoldPlanDigest(plan);
  if (receipt.planDigest !== plan.planDigest) {
    invalidReceipt("Scaffolding Receipt references a different Plan digest.");
  }
  const planOperations = new Map(
    plan.operations.map((operation) => [operation.id, operation] as const)
  );
  for (const operation of receipt.operations) {
    const planned = planOperations.get(operation.operationId);
    if (planned === undefined || planned.path !== operation.path) {
      invalidReceipt(
        `Scaffolding Receipt operation does not match its Plan evidence: ${operation.operationId}.`
      );
    }
    if (
      hasObservedPostImage(operation.outcome) &&
      operation.resultDigest !== planned.after.digest
    ) {
      invalidReceipt(
        `Scaffolding Receipt result digest does not match its Plan evidence: ${operation.operationId}.`
      );
    }
  }
  if (
    (receipt.outcome === "applied" ||
      receipt.outcome === "already-applied" ||
      receipt.outcome === "failed-recovered") &&
    receipt.operations.length !== plan.operations.length
  ) {
    invalidReceipt(
      "A completed Scaffolding Receipt must provide evidence for every Plan operation."
    );
  }
}

function assertScaffoldReceiptCandidateDigest(
  receipt: ScaffoldReceiptCandidateV1,
  plan?: ScaffoldPlanV1
): void {
  assertReceiptContract(receipt);
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  const expected = sha256Json(body as unknown as JsonValue);
  if (receipt.receiptDigest !== expected) {
    invalidReceipt(
      "Scaffolding Receipt digest does not match its canonical content."
    );
  }
  if (plan !== undefined) {
    assertPlanEvidence(receipt, plan);
  }
}

/**
 * Verifies digest and semantic evidence for a schema-validated Receipt.
 * Use `validateScaffoldReceipt` when the value comes from an untrusted source.
 */
export function assertScaffoldReceiptDigest(
  receipt: ScaffoldReceiptV1,
  plan?: ScaffoldPlanV1
): void {
  assertScaffoldReceiptCandidateDigest(receipt, plan);
}

export function createScaffoldReceipt(
  options: CreateScaffoldReceiptOptions
): ScaffoldReceiptV1 {
  const body = {
    schemaVersion: 1 as const,
    protocolVersion: 1 as const,
    planDigest: options.plan.planDigest,
    adapter: Object.freeze({
      id: options.adapterId,
      contractVersion: 1 as const
    }),
    outcome: options.outcome,
    commit: Object.freeze({
      state: options.commitState,
      atomicity: options.atomicity
    }),
    operations: Object.freeze([...options.operations]),
    diagnostics: Object.freeze([...(options.diagnostics ?? [])])
  };
  const receipt: ScaffoldReceiptCandidateV1 = {
    ...body,
    receiptDigest: sha256Json(body as unknown as JsonValue)
  };
  assertScaffoldReceiptCandidateDigest(receipt, options.plan);
  return Object.freeze(receipt) as unknown as ScaffoldReceiptV1;
}
