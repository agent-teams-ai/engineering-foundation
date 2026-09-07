import type {
  JsonValue
} from "../application/model/scaffold-values.js";
import type {
  ScaffoldPlan
} from "../application/model/scaffold-compilation.js";
import { ScaffoldError } from "../scaffold-error.js";
import { sha256Bytes, sha256Json } from "./canonical-json.js";
import {
  MAX_SCAFFOLD_FILE_BYTES,
  MAX_SCAFFOLD_OPERATIONS,
  MAX_SCAFFOLD_TOTAL_BYTES
} from "./limits.js";

export function assertScaffoldPlanContent(plan: ScaffoldPlan): void {
  const { planDigest: _planDigest, ...body } = plan;
  const expected = sha256Json(body as unknown as JsonValue);
  if (plan.planDigest !== expected) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan digest does not match its canonical content."
    );
  }
  if (
    plan.operations.length === 0 ||
    plan.operations.length > MAX_SCAFFOLD_OPERATIONS
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan must contain a bounded non-empty operation set."
    );
  }
  const adapterCapabilities = plan.requiredAdapterCapabilities as readonly string[];
  if (
    adapterCapabilities.length !== 1 ||
    adapterCapabilities[0] !== "materialize-file/v1"
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan requires unsupported adapter capabilities."
    );
  }
  const operationIds = new Set<string>();
  const operationPaths = new Set<string>();
  const targetPrefix = `${plan.target.path}/`;
  let totalBytes = 0;
  for (const operation of plan.operations) {
    const maximumBase64Length = 4 * Math.ceil(MAX_SCAFFOLD_FILE_BYTES / 3);
    if (typeof operation.after.contentBase64 !== "string" ||
      operation.after.contentBase64.length > maximumBase64Length ||
      !Number.isSafeInteger(operation.after.size) || operation.after.size < 0 ||
      operation.after.size > MAX_SCAFFOLD_FILE_BYTES) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding operation content is outside its byte bound: ${operation.id}.`
      );
    }
    const bytes = Buffer.from(operation.after.contentBase64, "base64");
    if (
      bytes.toString("base64") !== operation.after.contentBase64 ||
      bytes.byteLength !== operation.after.size ||
      sha256Bytes(bytes) !== operation.after.digest
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding operation content is invalid: ${operation.id}.`
      );
    }
    if (!operation.path.startsWith(targetPrefix)) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding operation escapes target ${plan.target.id}: ${operation.path}.`
      );
    }
    if (operationIds.has(operation.id) || operationPaths.has(operation.path)) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding operation identity or path is duplicated: ${operation.id}.`
      );
    }
    operationIds.add(operation.id);
    operationPaths.add(operation.path);
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > MAX_SCAFFOLD_TOTAL_BYTES) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      `Scaffolding Plan output exceeds ${MAX_SCAFFOLD_TOTAL_BYTES} bytes.`
    );
  }
}
