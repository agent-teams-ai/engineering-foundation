import type {
  ScaffoldDiagnosticV1,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReceiptV1
} from "../../contract/types.js";
import { sha256Bytes } from "../../kernel/canonical-json.js";
import { assertScaffoldPlanDigest } from "../../kernel/compiler.js";
import { createScaffoldReceipt } from "../../kernel/receipt.js";
import { assertSchema } from "../../../schema-catalog.js";

export class MemoryScaffoldWorkspace {
  readonly #files: Map<string, Uint8Array>;

  constructor(files: Readonly<Record<string, string | Uint8Array>> = {}) {
    this.#files = new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        typeof content === "string"
          ? Buffer.from(content, "utf8")
          : Uint8Array.from(content)
      ])
    );
  }

  read(path: string): Uint8Array | undefined {
    const value = this.#files.get(path);
    return value === undefined ? undefined : Uint8Array.from(value);
  }

  entries(): Readonly<Record<string, Uint8Array>> {
    return Object.fromEntries(
      [...this.#files.entries()]
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, content]) => [path, Uint8Array.from(content)])
    );
  }

  async apply(plan: ScaffoldPlanV1): Promise<ScaffoldReceiptV1> {
    await assertSchema("scaffold-plan/v1", plan, "scaffold-memory-apply-plan");
    assertScaffoldPlanDigest(plan);
    const diagnostics: ScaffoldDiagnosticV1[] = [];
    const classifications = plan.operations.map((operation) => {
      const current = this.#files.get(operation.path);
      if (current === undefined) {
        return { operation, state: "absent" as const };
      }
      if (sha256Bytes(current) === operation.after.digest) {
        return { operation, state: "after" as const };
      }
      diagnostics.push({
        ruleId: "scaffolding.apply.precondition-conflict",
        severity: "error",
        phase: "apply",
        subject: operation.path,
        message: "Workspace content matches neither the Plan precondition nor its desired result.",
        remediation: "Create a new Intent and Plan from the current workspace state."
      });
      return { operation, state: "conflict" as const };
    });
    if (classifications.some(({ state }) => state === "conflict")) {
      return createScaffoldReceipt({
        plan,
        adapterId: "foundation.memory/v1",
        outcome: "rejected",
        commitState: "rejected",
        atomicity: "memory-atomic",
        operations: classifications.map(({ operation, state }) => ({
          operationId: operation.id,
          path: operation.path,
          outcome:
            state === "conflict"
              ? "conflict"
              : state === "after"
                ? "already-satisfied"
                : "not-applied",
          ...(state === "after" ? { resultDigest: operation.after.digest } : {})
        })),
        diagnostics
      });
    }

    const next = new Map(this.#files);
    const receipts: ScaffoldOperationReceiptV1[] = classifications.map(
      ({ operation, state }) => {
        if (state === "absent") {
          next.set(
            operation.path,
            Buffer.from(operation.after.contentBase64, "base64")
          );
        }
        return {
          operationId: operation.id,
          path: operation.path,
          outcome: state === "absent" ? "applied" : "already-satisfied",
          resultDigest: operation.after.digest
        };
      }
    );
    this.#files.clear();
    for (const [path, content] of next) {
      this.#files.set(path, content);
    }
    const changed = classifications.some(({ state }) => state === "absent");
    return createScaffoldReceipt({
      plan,
      adapterId: "foundation.memory/v1",
      outcome: changed ? "applied" : "already-applied",
      commitState: "committed",
      atomicity: "memory-atomic",
      operations: receipts
    });
  }
}
