import { sha256Json as sha256DocumentJson, type CanonicalJsonValue } from "@agent-teams/repository-mutation";
import { legacyFoundationEnvelopeSha256Json } from "./legacy-document-envelope-v2.js";

export function assertEnvelopeDigests(envelope: Record<string, unknown>): void {
  const sha256EnvelopeJson = (value: unknown): string =>
    envelope["operationKind"] === "scaffolding"
      ? legacyFoundationEnvelopeSha256Json(value)
      : sha256DocumentJson(value as CanonicalJsonValue);
  const journal = envelope["journal"];
  if (envelope["payloadDigest"] !== sha256EnvelopeJson(journal)) {
    throw new Error("Foundation transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== sha256EnvelopeJson(body)) {
    throw new Error("Foundation transaction envelope digest is invalid.");
  }
}

