import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../canonical-json.js";
import { assertSchema } from "../../schema-catalog.js";
import type {
  DocumentReceipt,
  DocumentReceiptContract,
  DocumentReceiptBody
} from "../model/document-receipt.js";
import type { DocumentPlanContract as DocumentPlan } from "../model/document-planning.js";
import {
  assertDocumentReceiptDigest,
  documentReceiptDigest
} from "./document-contract-digests.js";

function snapshotBody(body: DocumentReceiptBody): DocumentReceiptBody {
  return JSON.parse(
    canonicalJson(body as unknown as CanonicalJsonValue)
  ) as DocumentReceiptBody;
}

function deepFreezeCanonical<T>(value: T): T {
  const pending: object[] = [];
  if (value !== null && typeof value === "object") {
    pending.push(value);
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || Object.isFrozen(current)) {
      continue;
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      const child: unknown = descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
      if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function requireDocumentPlan(
  plan: DocumentPlan | undefined
): asserts plan is DocumentPlan {
  if (plan === undefined) {
    throw new TypeError("Document Receipt requires the exact referenced Plan.");
  }
}

function assertDirectoryPrefix(
  receipt: Extract<DocumentReceiptContract, { readonly schemaVersion: 2 }>,
  plan: Extract<DocumentPlan, { readonly schemaVersion: 2 }>
): void {
  const evidence = receipt.directoryMaterialization;
  const planned = plan.parentMaterialization.missingDirectories;
  if (evidence.plannedDirectories.length !== planned.length ||
    evidence.plannedDirectories.some((path, index) => path !== planned[index]) ||
    evidence.observedCreatedDirectories.length > planned.length ||
    evidence.observedCreatedDirectories.some((path, index) => path !== planned[index])) {
    throw new TypeError(
      "Document Receipt directory evidence must bind the exact ordered Plan prefix."
    );
  }
}

function inconsistentDirectoryOutcome(
  receipt: Extract<DocumentReceiptContract, { readonly schemaVersion: 2 }>,
  plan: Extract<DocumentPlan, { readonly schemaVersion: 2 }>
): boolean {
  const evidence = receipt.directoryMaterialization;
  const planned = plan.parentMaterialization.missingDirectories;
  return (evidence.state === "none-created" &&
      evidence.observedCreatedDirectories.length !== 0) ||
    (evidence.state === "preserved-unknown" &&
      receipt.outcome !== "recovery-required" &&
      receipt.outcome !== "manual-recovery-required") ||
    (receipt.outcome === "already-applied" && evidence.state !== "none-created") ||
    (receipt.outcome === "applied" && planned.length === 0 &&
      evidence.state !== "none-created") ||
    (receipt.outcome === "applied" && planned.length > 0 &&
      (evidence.state !== "created-and-retained" ||
        evidence.observedCreatedDirectories.length !== planned.length));
}

function assertV2DirectoryReceipt(
  receipt: DocumentReceiptContract,
  plan: DocumentPlan
): void {
  if (receipt.schemaVersion !== 2 || plan.schemaVersion !== 2) {
    return;
  }
  assertDirectoryPrefix(receipt, plan);
  if (inconsistentDirectoryOutcome(receipt, plan)) {
    throw new TypeError("Document Receipt directory materialization outcome is inconsistent.");
  }
}

export async function createDocumentReceipt(
  body: DocumentReceiptBody,
  plan: DocumentPlan | undefined
): Promise<DocumentReceiptContract> {
  const snapshot = deepFreezeCanonical(snapshotBody(body));
  const receipt = deepFreezeCanonical({
    ...snapshot,
    receiptDigest: documentReceiptDigest(
      snapshot as unknown as Readonly<Record<string, CanonicalJsonValue>>
    )
  }) as DocumentReceiptContract;
  await assertSchema(
    receipt.schemaVersion === 2 ? "document-receipt/v2" : "document-receipt/v1",
    receipt,
    "document-receipt"
  );
  requireDocumentPlan(plan);
  assertV2DirectoryReceipt(receipt, plan);
  assertDocumentReceiptDigest(receipt, plan);
  return receipt;
}

export async function assertDocumentReceipt(
  receipt: unknown,
  plan: DocumentPlan | undefined
): Promise<DocumentReceipt> {
  const snapshot = deepFreezeCanonical(
    JSON.parse(canonicalJson(receipt as CanonicalJsonValue)) as unknown
  );
  await assertSchema(
    (snapshot as { readonly schemaVersion?: unknown }).schemaVersion === 2
      ? "document-receipt/v2"
      : "document-receipt/v1",
    snapshot,
    "document-receipt"
  );
  requireDocumentPlan(plan);
  const documentReceipt = snapshot as DocumentReceipt;
  assertV2DirectoryReceipt(documentReceipt, plan);
  assertDocumentReceiptDigest(documentReceipt, plan);
  return documentReceipt;
}
