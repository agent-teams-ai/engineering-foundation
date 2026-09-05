import { isProxy } from "node:util/types";

import { CapabilityInputError } from "../../../documentation-observation/api.js";
import { assertSchema } from "./schema-catalog.js";
import type {
  DocumentIntent,
  DocumentPlanContract as DocumentPlan
} from "../../application/model/document-planning.js";
import type { DocumentContractValidator } from "../../application/ports/document-contract-validator.js";
import { DocumentPlanningError } from "../../application/model/document-planning-error.js";
import { assertDocumentPlanDigests } from "../../application/policies/document-contract-digests.js";

function invalidContract(kind: "Intent" | "Plan", error: CapabilityInputError): never {
  throw new DocumentPlanningError(
    kind === "Intent"
      ? "DOCUMENT_PLANNING_INPUT_INVALID"
      : "DOCUMENT_PLANNING_OUTPUT_INVALID",
    `Document ${kind} does not match its closed contract: ${error.message.slice(0, 1000)}`,
    { cause: error }
  );
}

const MAXIMUM_INTENT_DEPTH = 8;
const MAXIMUM_INTENT_CONTAINER_ITEMS = 128;
const MAXIMUM_DOCUMENT_OUTPUT_BYTES = 1024 * 1024;
const MAXIMUM_PLAN_DEPTH = 12;
const MAXIMUM_PLAN_JSON_BYTES = 4 * MAXIMUM_DOCUMENT_OUTPUT_BYTES;
const MAXIMUM_PLAN_VALUES = MAXIMUM_DOCUMENT_OUTPUT_BYTES;
const OUTPUT_INTENT_KEYS = new Set([
  "additionalMetadata",
  "id",
  "owner",
  "related",
  "summary",
  "title",
  "type"
]);
const INTENT_ROOT_KEYS = new Set([
  ...OUTPUT_INTENT_KEYS,
  "destination",
  "schemaVersion",
  "slug"
]);
const STRING_INTENT_ROOT_KEYS = new Set([
  "destination",
  "id",
  "owner",
  "slug",
  "summary",
  "title",
  "type"
]);

interface IntentInspectionBudget {
  outputLowerBoundBytes: number;
}

function addOutputLowerBound(
  budget: IntentInspectionBudget,
  bytes: number
): void {
  budget.outputLowerBoundBytes += bytes;
  if (budget.outputLowerBoundBytes > MAXIMUM_DOCUMENT_OUTPUT_BYTES) {
    throw new TypeError(
      "Document Intent logically expands beyond the public document output byte limit."
    );
  }
}

function isJsonScalar(
  value: unknown,
  contributesToOutput: boolean,
  budget: IntentInspectionBudget
): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (contributesToOutput) {
      addOutputLowerBound(
        budget,
        1 + (typeof value === "string"
          ? Buffer.byteLength(value.normalize("NFC"), "utf8")
          : 1)
      );
    }
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Document Intent numbers must be safe integers other than negative zero.");
    }
    if (contributesToOutput) {
      addOutputLowerBound(budget, 1);
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

function assertIntentRootField(key: string, value: unknown): void {
  if (!INTENT_ROOT_KEYS.has(key)) {
    throw new TypeError("Document Intent contains an unknown root field.");
  }
  if (STRING_INTENT_ROOT_KEYS.has(key) && typeof value !== "string") {
    throw new TypeError(`Document Intent root field ${key} must be a string.`);
  }
  if (key === "schemaVersion" && value !== 1) {
    throw new TypeError("Document Intent schemaVersion must equal 1.");
  }
}

function assertInertJson(input: unknown): void {
  const pending: (
    | {
        readonly action: "enter";
        readonly contributesToOutput: boolean;
        readonly depth: number;
        readonly value: unknown;
      }
    | { readonly action: "leave"; readonly value: object }
  )[] = [
    { action: "enter", contributesToOutput: false, depth: 0, value: input }
  ];
  const ancestors = new WeakSet<object>();
  const budget: IntentInspectionBudget = { outputLowerBoundBytes: 0 };
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.action === "leave") {
      ancestors.delete(current.value);
      continue;
    }
    if (isJsonScalar(current.value, current.contributesToOutput, budget)) {
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
    if (current.contributesToOutput) {
      addOutputLowerBound(budget, 1);
    }
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
      if (current.depth === 0) {
        assertIntentRootField(key, descriptor.value);
      }
      pending.push({
        action: "enter",
        contributesToOutput: current.depth === 0
          ? OUTPUT_INTENT_KEYS.has(key)
          : current.contributesToOutput,
        depth: current.depth + 1,
        value: descriptor.value
      });
    }
  }
}

interface PlanSnapshotFrame {
  readonly depth: number;
  readonly source: object;
  readonly target: Record<string, unknown> | unknown[];
}

interface PlanInspectionBudget {
  bytes: number;
  values: number;
}

function planContractTypeError(message: string): TypeError {
  return new TypeError(`Document Plan ${message}`);
}

function defineSnapshotValue(
  target: Record<string, unknown> | unknown[],
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function inspectPlanContainer(source: object): {
  readonly isArray: boolean;
  readonly keys: readonly string[];
} {
  if (isProxy(source)) {
    throw planContractTypeError("must not contain Proxy objects.");
  }
  const isArray = Array.isArray(source);
  const prototype = Object.getPrototypeOf(source) as object | null;
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    throw planContractTypeError("containers must use intrinsic JSON prototypes.");
  }
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string")) {
    throw planContractTypeError("must not contain symbol keys.");
  }
  if (isArray && keys.length !== source.length + 1) {
    throw planContractTypeError("arrays must be dense and contain no extra properties.");
  }
  if (
    isArray &&
    keys.some(
      (key) =>
        key !== "length" &&
        (!/^(?:0|[1-9]\d*)$/u.test(String(key)) ||
          Number(key) >= source.length ||
          String(Number(key)) !== key)
    )
  ) {
    throw planContractTypeError("arrays must be dense and contain no extra properties.");
  }
  return {
    isArray,
    keys: (keys as string[])
      .filter((key) => !(isArray && key === "length"))
      .toSorted()
  };
}

function planDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true
  ) {
    throw planContractTypeError("must contain only enumerable own data properties.");
  }
  return descriptor.value as unknown;
}

function accountPlanValue(
  budget: PlanInspectionBudget,
  key: string,
  value: unknown
): void {
  budget.values += 1;
  budget.bytes += Buffer.byteLength(key, "utf8") + 1;
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8") + 1;
  } else if (value === null || ["boolean", "number"].includes(typeof value)) {
    budget.bytes += 1;
  }
  if (budget.values > MAXIMUM_PLAN_VALUES || budget.bytes > MAXIMUM_PLAN_JSON_BYTES) {
    throw planContractTypeError("exceeds the bounded v1 contract input budget.");
  }
}

function assertPlanScalar(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value !== "number") {
    return false;
  }
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw planContractTypeError(
      "numbers must be safe integers other than negative zero."
    );
  }
  return true;
}

function snapshotInertPlan(input: unknown): DocumentPlan {
  if (input === null || typeof input !== "object") {
    throw planContractTypeError("must be a JSON object.");
  }
  if (isProxy(input) || Array.isArray(input)) {
    throw planContractTypeError("must be an intrinsic, non-Proxy JSON object.");
  }
  const root: Record<string, unknown> = {};
  const pending: PlanSnapshotFrame[] = [{ depth: 0, source: input, target: root }];
  const observed = new WeakSet<object>();
  const budget: PlanInspectionBudget = { bytes: 0, values: 0 };

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (observed.has(current.source)) {
      throw planContractTypeError("must be an acyclic JSON tree without shared containers.");
    }
    observed.add(current.source);
    if (current.depth > MAXIMUM_PLAN_DEPTH) {
      throw planContractTypeError("exceeds the supported JSON depth.");
    }
    const { keys } = inspectPlanContainer(current.source);
    for (const key of keys) {
      const value = planDataValue(current.source, key);
      accountPlanValue(budget, key, value);
      if (assertPlanScalar(value)) {
        defineSnapshotValue(current.target, key, value);
        continue;
      }
      if (value === null || typeof value !== "object") {
        throw planContractTypeError("must use the closed JSON data model.");
      }
      if (isProxy(value)) {
        throw planContractTypeError("must not contain Proxy objects.");
      }
      const child: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
      defineSnapshotValue(current.target, key, child);
      pending.push({ depth: current.depth + 1, source: value, target: child });
    }
    Object.freeze(current.target);
  }
  return root as unknown as DocumentPlan;
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
      const snapshot = snapshotInertPlan(input);
      await assertSchema(
        snapshot.schemaVersion === 2
          ? "document-authoring/document-plan/v2"
          : "document-authoring/document-plan/v1",
        snapshot,
        "document-plan"
      );
      assertDocumentPlanDigests(snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof CapabilityInputError) {
        invalidContract("Plan", error);
      }
      if (error instanceof Error) {
        throw new DocumentPlanningError(
          "DOCUMENT_PLANNING_OUTPUT_INVALID",
          `Document Plan must use inert canonical JSON data and valid content bindings: ${error.message.slice(0, 1000)}`,
          { cause: error }
        );
      }
      throw error;
    }
  }
}
