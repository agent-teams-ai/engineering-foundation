import {
  canonicalJson,
  type CanonicalJsonValue
} from "../../../canonical-json.js";
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

export function createDocumentReceipt(
  body: DocumentReceiptBody,
  plan?: DocumentPlan
): DocumentReceipt {
  const snapshot = snapshotBody(body);
  const receipt = Object.freeze({
    ...snapshot,
    receiptDigest: documentReceiptDigest(
      snapshot as unknown as Readonly<Record<string, CanonicalJsonValue>>
    )
  }) as DocumentReceipt;
  assertDocumentReceiptDigest(receipt, plan);
  return receipt;
}

export function assertDocumentReceipt(
  receipt: unknown,
  plan?: DocumentPlan
): asserts receipt is DocumentReceipt {
  assertDocumentReceiptDigest(receipt, plan);
}
