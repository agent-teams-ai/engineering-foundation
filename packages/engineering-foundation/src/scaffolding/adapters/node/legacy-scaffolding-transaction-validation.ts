import { sha256Json as sha256DocumentJson } from "../../../canonical-json.js";
import type {
  AuthorityScaffoldJournal
} from "../../contract/types.js";
import type {
  JsonValue
} from "../../application/model/scaffold-values.js";
import { assertAuthorityScaffoldJournal } from "../inbound/assert-authority-scaffold-journal.js";
import { legacyFoundationEnvelopeSha256Json } from "../../../transaction-coordination/adapters/node/legacy-document-envelope-v2.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLegacyScaffoldingValue(value: unknown): unknown {
  if (typeof value === "number") {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return value.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLegacyScaffoldingValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, normalizeLegacyScaffoldingValue(item)
    ]));
  }
  return value;
}

export function assertLegacyScaffoldingJournal(journal: Record<string, unknown>): void {
  const plan = journal["plan"];
  if (!isRecord(plan)) {
    throw new Error("Legacy scaffolding Plan binding is invalid.");
  }
  const { planDigest, ...body } = plan;
  if (planDigest !== legacyFoundationEnvelopeSha256Json(body)) {
    throw new Error("Legacy scaffolding Plan digest is invalid.");
  }
  const normalized = normalizeLegacyScaffoldingValue(journal) as AuthorityScaffoldJournal;
  const { planDigest: _normalizedDigest, ...normalizedBody } = normalized.plan;
  (normalized as unknown as { plan: { planDigest: string } }).plan.planDigest =
    sha256DocumentJson(normalizedBody as unknown as JsonValue);
  assertAuthorityScaffoldJournal(normalized);
}
