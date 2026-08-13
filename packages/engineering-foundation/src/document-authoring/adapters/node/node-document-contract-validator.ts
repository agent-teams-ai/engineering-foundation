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

function assertInertJson(value: unknown, ancestors = new WeakSet<object>()): void {
  if (isJsonScalar(value)) {
    return;
  }
  if (value === null || typeof value !== "object") {
    throw new TypeError("Document Intent must use the closed JSON data model.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Document Intent must not contain cycles.");
  }
  assertIntrinsicJsonContainer(value);
  ancestors.add(value);
  try {
    for (const key of inertContainerKeys(value)) {
      if (key === "length" && Array.isArray(value)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("Document Intent must contain only enumerable own data properties.");
      }
      assertInertJson(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
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
