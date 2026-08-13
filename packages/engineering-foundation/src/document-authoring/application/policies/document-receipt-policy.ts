import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
import { assertSchema } from "../../../schema-catalog.js";
import type {
  DocumentReceipt,
  DocumentReceiptBody
} from "../model/document-receipt.js";
import type { DocumentPlan } from "../model/document-planning.js";
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

export async function createDocumentReceipt(
  body: DocumentReceiptBody,
  plan: DocumentPlan | undefined
): Promise<DocumentReceipt> {
  const snapshot = deepFreezeCanonical(snapshotBody(body));
  const receipt = deepFreezeCanonical({
    ...snapshot,
    receiptDigest: documentReceiptDigest(
      snapshot as unknown as Readonly<Record<string, CanonicalJsonValue>>
    )
  }) as DocumentReceipt;
  await assertSchema("document-receipt/v1", receipt, "document-receipt");
  requireDocumentPlan(plan);
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
  await assertSchema("document-receipt/v1", snapshot, "document-receipt");
  requireDocumentPlan(plan);
  assertDocumentReceiptDigest(snapshot, plan);
  return snapshot as DocumentReceipt;
}
