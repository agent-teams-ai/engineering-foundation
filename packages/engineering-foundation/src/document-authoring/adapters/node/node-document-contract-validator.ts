import { isProxy } from "node:util/types";

import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import type {
  DocumentIntent,
  DocumentPlan
} from "../../application/model/document-planning.js";
import type { DocumentContractValidator } from "../../application/ports/document-contract-validator.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

function invalidContract(kind: "Intent" | "Plan", error: CapabilityInputError): never {
  throw new DocumentPlanningError(
    kind === "Intent"
      ? "DOCUMENT_PLANNING_INPUT_INVALID"
      : "DOCUMENT_PLANNING_OUTPUT_INVALID",
    `Document ${kind} does not match its v1 contract: ${error.message.slice(0, 1000)}`,
    { cause: error }
  );
}

const MAXIMUM_INTENT_DEPTH = 8;
const MAXIMUM_INTENT_CONTAINER_ITEMS = 128;

function isJsonScalar(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Document Intent numbers must be safe integers other than negative zero.");
    }
    return true;
  }
  return false;
}

function inertContainerKeys(value: object): readonly string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Document Intent must not contain symbol keys.");
  }
  const itemCount = Array.isArray(value) ? keys.length - 1 : keys.length;
  if (itemCount > MAXIMUM_INTENT_CONTAINER_ITEMS) {
    throw new TypeError("Document Intent container exceeds the item budget.");
  }
  if (Array.isArray(value) && keys.length !== value.length + 1) {
    throw new TypeError("Document Intent arrays must be dense and contain no extra properties.");
  }
  return keys as string[];
}

function assertIntrinsicJsonContainer(value: object): void {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (
    (Array.isArray(value) && prototype !== Array.prototype) ||
    (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError("Document Intent containers must use intrinsic JSON prototypes.");
  }
}

function assertInertJson(input: unknown): void {
  const pending: (
    | { readonly action: "enter"; readonly depth: number; readonly value: unknown }
    | { readonly action: "leave"; readonly value: object }
  )[] = [
    { action: "enter", depth: 0, value: input }
  ];
  const ancestors = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.action === "leave") {
      ancestors.delete(current.value);
      continue;
    }
    if (isJsonScalar(current.value)) {
      continue;
    }
    if (current.value === null || typeof current.value !== "object") {
      throw new TypeError("Document Intent must use the closed JSON data model.");
    }
    if (isProxy(current.value)) {
      throw new TypeError("Document Intent must not contain Proxy objects.");
    }
    if (current.depth > MAXIMUM_INTENT_DEPTH || ancestors.has(current.value)) {
      throw new TypeError("Document Intent must be a bounded acyclic JSON tree.");
    }
    assertIntrinsicJsonContainer(current.value);
    ancestors.add(current.value);
    pending.push({ action: "leave", value: current.value });
    for (const key of inertContainerKeys(current.value)) {
      if (key === "length" && Array.isArray(current.value)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("Document Intent must contain only enumerable own data properties.");
      }
      pending.push({
        action: "enter",
        depth: current.depth + 1,
        value: descriptor.value
      });
    }
  }
}

export class NodeDocumentContractValidator implements DocumentContractValidator {
  async validateIntent(input: unknown): Promise<DocumentIntent> {
    try {
      assertInertJson(input);
      await assertSchema("document-intent/v1", input, "document-intent");
      return input as DocumentIntent;
    } catch (error) {
      if (error instanceof CapabilityInputError) {
        invalidContract("Intent", error);
      }
      if (error instanceof TypeError) {
        throw new DocumentPlanningError(
          "DOCUMENT_PLANNING_INPUT_INVALID",
          `Document Intent must use inert canonical JSON data: ${error.message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  async validatePlan(input: unknown): Promise<DocumentPlan> {
    try {
      await assertSchema("document-plan/v1", input, "document-plan");
      return input as DocumentPlan;
    } catch (error) {
      if (error instanceof CapabilityInputError) {
        invalidContract("Plan", error);
      }
      throw error;
    }
  }
}
