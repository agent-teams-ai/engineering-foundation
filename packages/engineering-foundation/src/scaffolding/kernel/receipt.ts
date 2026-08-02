import type {
  JsonValue,
  ScaffoldDiagnosticV1,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReceiptOutcome,
  ScaffoldReceiptV1
} from "../contract/types.js";
import { sha256Json } from "./canonical-json.js";

export function createScaffoldReceipt(options: {
  readonly plan: ScaffoldPlanV1;
  readonly adapterId:
    | "foundation.filesystem/v1"
    | "foundation.memory/v1";
  readonly outcome: ScaffoldReceiptOutcome;
  readonly commitState: ScaffoldReceiptV1["commit"]["state"];
  readonly atomicity: ScaffoldReceiptV1["commit"]["atomicity"];
  readonly operations: readonly ScaffoldOperationReceiptV1[];
  readonly diagnostics?: readonly ScaffoldDiagnosticV1[];
}): ScaffoldReceiptV1 {
  const planOperations = new Map(
    options.plan.operations.map((operation) => [operation.id, operation] as const)
  );
  const receiptOperationIds = new Set<string>();
  for (const operation of options.operations) {
    const planned = planOperations.get(operation.operationId);
    if (
      planned === undefined ||
      planned.path !== operation.path ||
      receiptOperationIds.has(operation.operationId)
    ) {
      throw new Error(
        `Receipt operation does not identify one unique Plan operation: ${operation.operationId}.`
      );
    }
    receiptOperationIds.add(operation.operationId);
    const observedPostImage =
      operation.outcome === "already-satisfied" ||
      operation.outcome === "applied" ||
      operation.outcome === "recovered";
    if (
      observedPostImage
        ? operation.resultDigest !== planned.after.digest
        : operation.resultDigest !== undefined
    ) {
      throw new Error(
        `Receipt operation has inconsistent result evidence: ${operation.operationId}.`
      );
    }
  }
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
  return Object.freeze({
    ...body,
    receiptDigest: sha256Json(body as unknown as JsonValue)
  });
}
