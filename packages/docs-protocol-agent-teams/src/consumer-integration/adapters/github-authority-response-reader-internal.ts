/** Feature-private bounded response reader; no package export or graph node. */
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

const MAXIMUM_AUTHORITY_BYTES = 8 * 1024 * 1024;

async function rejectAuthorityBody(
  body: Pick<ReadableStream<Uint8Array>, "cancel"> | null,
  error: ConsumerIntegrationNodeError
): Promise<never> {
  try {
    await body?.cancel(error);
  } catch (cause) {
    throw new ConsumerIntegrationNodeError(error.code, error.message, { cause });
  }
  throw error;
}

export async function responseBytes(response: Response, subject: string): Promise<Uint8Array> {
  if (!response.ok) {
    return rejectAuthorityBody(response.body, new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_UNAVAILABLE",
      `${subject} returned HTTP ${response.status}.`
    ));
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAXIMUM_AUTHORITY_BYTES) {
    return rejectAuthorityBody(response.body, new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} exceeds the authority size limit.`
    ));
  }
  const invalidBytes = new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_AUTHORITY_INVALID",
    `${subject} has invalid or overlong bytes.`
  );
  if (response.body === null) {throw invalidBytes;}
  const reader = response.body.getReader();
  // Copy into bounded storage; tiny chunks must not create an unbounded object list.
  let bytes = new Uint8Array(64 * 1024);
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {break;}
      const nextLength = byteLength + value.byteLength;
      if (nextLength > MAXIMUM_AUTHORITY_BYTES) {
        return await rejectAuthorityBody(reader, invalidBytes);
      }
      if (nextLength > bytes.byteLength) {
        const capacity = Math.min(MAXIMUM_AUTHORITY_BYTES, Math.max(nextLength, bytes.byteLength * 2));
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, byteLength));
        bytes = expanded;
      }
      bytes.set(value, byteLength);
      byteLength = nextLength;
    }
    if (byteLength === 0) {throw invalidBytes;}
    return bytes.subarray(0, byteLength);
  } finally {
    reader.releaseLock();
  }
}
