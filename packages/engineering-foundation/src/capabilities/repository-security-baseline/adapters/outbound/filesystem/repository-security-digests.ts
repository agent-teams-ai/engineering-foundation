import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { repositorySecurityInputError } from "./repository-security-input.js";

const MAX_WORKFLOW_DIGEST_BYTES = 32 * 1024 * 1024;

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function digestParts(parts: readonly Uint8Array[]): Promise<string> {
  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_WORKFLOW_DIGEST_BYTES) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_EVIDENCE_TOO_LARGE",
      "Security workflow sources exceed the supported digest input size."
    );
  }
  const source = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    source.set(part, offset);
    offset += part.byteLength;
  }
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", source.buffer));
  return `sha256:${Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export async function digestEvidence(source: Uint8Array): Promise<string> {
  return digestParts([source]);
}

export async function digestWorkflowSources(
  entries: readonly { readonly path: string; readonly source: Uint8Array }[]
): Promise<string> {
  const parts: Uint8Array[] = [encode("repository-security-workflows-v1\u0000")];
  for (const entry of entries.toSorted((left, right) => compareBinaryStrings(left.path, right.path))) {
    parts.push(
      encode(entry.path),
      encode("\u0000"),
      encode(String(entry.source.byteLength)),
      encode("\u0000"),
      entry.source,
      encode("\u0000")
    );
  }
  return digestParts(parts);
}
