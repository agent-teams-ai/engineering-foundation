import { createHash } from "node:crypto";

import type { JsonValue, Sha256Digest } from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertCanonicalString(value: string): void {
  if (value.normalize("NFC") !== value) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Scaffolding JSON strings must use NFC normalization."
    );
  }
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertCanonicalString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        "Scaffolding JSON numbers must be finite safe integers."
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    return `[${items.map((item) => canonicalize(item)).join(",")}]`;
  }

  const entries = Object.entries(
    value as Readonly<Record<string, JsonValue>>
  ).toSorted(([left], [right]) => compareStrings(left, right));
  for (const [key] of entries) {
    assertCanonicalString(key);
  }
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(value);
}

export function sha256Bytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Text(value: string): Sha256Digest {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function sha256Json(value: JsonValue): Sha256Digest {
  return sha256Text(canonicalJson(value));
}
