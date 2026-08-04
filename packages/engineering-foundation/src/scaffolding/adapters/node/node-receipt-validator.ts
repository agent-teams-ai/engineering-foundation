import type {
  ScaffoldPlanV1,
  ScaffoldReceiptV1
} from "../../contract/types.js";
import { assertScaffoldReceiptDigest } from "../../kernel/receipt.js";
import { assertSchema } from "../../../schema-catalog.js";

/** Validates an untrusted released 0.5 Receipt for regression evidence. */
export async function validateScaffoldReceipt(
  receipt: unknown,
  plan?: ScaffoldPlanV1
): Promise<ScaffoldReceiptV1> {
  await assertSchema(
    "scaffold-receipt/v1",
    receipt,
    "rendering-regression-receipt"
  );
  const validated = receipt as ScaffoldReceiptV1;
  assertScaffoldReceiptDigest(validated, plan);
  return validated;
}
