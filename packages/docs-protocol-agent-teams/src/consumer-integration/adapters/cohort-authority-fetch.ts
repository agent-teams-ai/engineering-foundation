import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";
export const AUTHORITY_REPOSITORY = "agent-teams-ai/.github";
export const AUTHORITY_PATH = "governance/docs-qualified-cohorts.json";
const AUTHORITY_API = `https://api.github.com/repos/${AUTHORITY_REPOSITORY}`;
const AUTHORITY_RAW = `https://raw.githubusercontent.com/${AUTHORITY_REPOSITORY}`;
export const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const MAXIMUM_AUTHORITY_BYTES = 8 * 1024 * 1024;
export const V1_MANAGED_PACKAGES = [
  "@agent-teams/docs-protocol",
  "@agent-teams/engineering-foundation",
] as const;

export type AuthorityFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export function record(value: unknown, subject: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one plain object.`,
    );
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one bounded array.`,
    );
  }
  return value;
}

export function string(value: unknown, subject: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\u0000")
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one bounded string.`,
    );
  }
  return value;
}

async function rejectAuthorityBody(
  body: Pick<ReadableStream<Uint8Array>, "cancel"> | null,
  error: ConsumerIntegrationNodeError,
): Promise<never> {
  try {
    await body?.cancel(error);
  } catch (cause) {
    throw new ConsumerIntegrationNodeError(error.code, error.message, { cause });
  }
  throw error;
}

async function responseBytes(response: Response, subject: string): Promise<Uint8Array> {
  if (!response.ok) {
    return rejectAuthorityBody(
      response.body,
      new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_UNAVAILABLE",
        `${subject} returned HTTP ${response.status}.`,
      ),
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAXIMUM_AUTHORITY_BYTES) {
    return rejectAuthorityBody(
      response.body,
      new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_INVALID",
        `${subject} exceeds the authority size limit.`,
      ),
    );
  }
  const invalidBytes = new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_AUTHORITY_INVALID",
    `${subject} has invalid or overlong bytes.`,
  );
  if (response.body === null) {
    throw invalidBytes;
  }
  const reader = response.body.getReader();
  // Copy into bounded storage; tiny chunks must not create an unbounded object list.
  let bytes = new Uint8Array(64 * 1024);
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const nextLength = byteLength + value.byteLength;
      if (nextLength > MAXIMUM_AUTHORITY_BYTES) {
        return await rejectAuthorityBody(reader, invalidBytes);
      }
      if (nextLength > bytes.byteLength) {
        const capacity = Math.min(
          MAXIMUM_AUTHORITY_BYTES,
          Math.max(nextLength, bytes.byteLength * 2),
        );
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, byteLength));
        bytes = expanded;
      }
      bytes.set(value, byteLength);
      byteLength = nextLength;
    }
    if (byteLength === 0) {
      throw invalidBytes;
    }
    return bytes.subarray(0, byteLength);
  } finally {
    reader.releaseLock();
  }
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

export async function resolveAuthorityRevision(fetcher: AuthorityFetch): Promise<string> {
  const bytes = await responseBytes(
    await fetcher(`${AUTHORITY_API}/commits/main`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-teams-docs" },
      redirect: "error",
      signal: timeoutSignal(),
    }),
    "Central authority revision",
  );
  const response = parseJsonRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const revision = response["sha"];
  if (typeof revision !== "string" || !GIT_SHA.test(revision)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central authority did not resolve one exact Git revision.",
    );
  }
  return revision;
}

export async function readAuthorityRegistry(
  fetcher: AuthorityFetch,
  revision: string,
): Promise<Record<string, unknown>> {
  const bytes = await responseBytes(
    await fetcher(`${AUTHORITY_RAW}/${revision}/${AUTHORITY_PATH}`, {
      headers: { Accept: "application/json", "User-Agent": "agent-teams-docs" },
      redirect: "error",
      signal: timeoutSignal(),
    }),
    "Central Cohort registry",
  );
  try {
    return parseJsonRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central Cohort registry is not strict duplicate-free UTF-8 JSON.",
      { cause: error },
    );
  }
}
