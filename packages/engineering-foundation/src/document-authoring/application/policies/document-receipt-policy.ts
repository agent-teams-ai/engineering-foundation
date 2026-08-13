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
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value;
}

export async function createDocumentReceipt(
  body: DocumentReceiptBody,
  plan: DocumentPlan
): Promise<DocumentReceipt> {
  if (plan === undefined) {
    throw new TypeError("Document Receipt requires the exact referenced Plan.");
  }
  const snapshot = deepFreezeCanonical(snapshotBody(body));
  const receipt = deepFreezeCanonical({
    ...snapshot,
    receiptDigest: documentReceiptDigest(
      snapshot as unknown as Readonly<Record<string, CanonicalJsonValue>>
    )
  }) as DocumentReceipt;
  await assertSchema("document-receipt/v1", receipt, "document-receipt");
  assertDocumentReceiptDigest(receipt, plan);
  return receipt;
}

export async function assertDocumentReceipt(
  receipt: unknown,
  plan: DocumentPlan
): Promise<DocumentReceipt> {
  if (plan === undefined) {
    throw new TypeError("Document Receipt requires the exact referenced Plan.");
  }
  const snapshot = deepFreezeCanonical(
    JSON.parse(canonicalJson(receipt as CanonicalJsonValue)) as unknown
  );
  await assertSchema("document-receipt/v1", snapshot, "document-receipt");
  assertDocumentReceiptDigest(snapshot, plan);
  return snapshot as DocumentReceipt;
}
