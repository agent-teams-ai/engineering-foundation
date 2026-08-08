import type {
  AuthorityScaffoldPlan,
  AuthorityScaffoldReceipt
} from "../../contract/types.js";
import { assertAuthorityScaffoldReceiptDigest } from "../../kernel/authority-receipt.js";
import { assertSchema } from "../../../schema-catalog.js";

/** Validates an untrusted canonical Receipt against structural and semantic evidence. */
export async function validateAuthorityScaffoldReceipt(
  receipt: unknown,
  plan?: AuthorityScaffoldPlan
): Promise<AuthorityScaffoldReceipt> {
  await assertSchema("scaffold-receipt/v1", receipt, "scaffold-receipt");
  const validated = receipt as AuthorityScaffoldReceipt;
  assertAuthorityScaffoldReceiptDigest(validated, plan);
  return validated;
}
