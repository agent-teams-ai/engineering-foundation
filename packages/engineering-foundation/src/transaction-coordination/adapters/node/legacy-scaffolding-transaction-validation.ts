import { sha256Json as sha256DocumentJson } from "../../../canonical-json.js";
import type { AuthorityScaffoldJournal, JsonValue } from "../../../scaffolding/contract/types.js";
import { assertAuthorityScaffoldJournal } from "../../../scaffolding/kernel/authority-journal-validation.js";
import { legacyFoundationEnvelopeSha256Json } from "./legacy-document-envelope-v2.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertEnvelopeDigests(envelope: Record<string, unknown>): void {
  const sha256EnvelopeJson = (value: unknown): string =>
    envelope["operationKind"] === "scaffolding"
      ? legacyFoundationEnvelopeSha256Json(value)
      : sha256DocumentJson(value as JsonValue);
  const journal = envelope["journal"];
  if (envelope["payloadDigest"] !== sha256EnvelopeJson(journal as JsonValue)) {
    throw new Error("Foundation transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== sha256EnvelopeJson(body as JsonValue)) {
    throw new Error("Foundation transaction envelope digest is invalid.");
  }
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
