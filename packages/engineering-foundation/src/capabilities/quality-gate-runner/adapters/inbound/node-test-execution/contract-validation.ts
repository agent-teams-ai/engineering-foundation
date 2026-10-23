export type Identity = { file: string; names: string[]; kind: "suite" | "test" };
export type Exception = Identity & {
  status: "omitted" | "skipped" | "todo";
  reason: string;
  applicability: { platforms: string[] };
};
const platforms = new Set(["darwin", "linux", "win32"]);
export const identityKey = (file: string, names: readonly string[]): string =>
  JSON.stringify([file, names]);
export function fail(message: string): never {
  throw new Error(`Node test execution contract: ${message}`);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: unknown, fields: string[]): boolean {
  return record(value) && Object.keys(value).toSorted().join("\0") === fields.toSorted().join("\0");
}
function identity(value: unknown, label: string): Identity {
  if (!exactKeys(value, ["file", "names", "kind"])) {
    fail(`${label} has invalid fields`);
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.file !== "string" ||
    item.file.length === 0 ||
    item.file.includes("\\") ||
    item.file.startsWith("/") ||
    item.file.includes("\0") ||
    item.file !== item.file.normalize("NFC") ||
    item.file
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part.includes(":"))
  ) {
    fail(`${label}.file must be a normalized relative entry path`);
  }
  if (
    !Array.isArray(item.names) ||
    item.names.length === 0 ||
    item.names.some(
      (name: unknown) => typeof name !== "string" || name.length === 0 || name.includes("\0"),
    )
  ) {
    fail(`${label}.names must contain full nonempty ancestry`);
  }
  if (item.kind !== "suite" && item.kind !== "test") {
    fail(`${label}.kind must be suite or test`);
  }
  return item as Identity;
}

function checkedException(raw: unknown, index: number, required: Map<string, Identity>): Exception {
  if (!exactKeys(raw, ["file", "names", "kind", "status", "reason", "applicability"])) {
    fail(`exceptions[${index}] has invalid fields`);
  }
  const item = raw as Exception;
  const checked = identity(
    { file: item.file, names: item.names, kind: item.kind },
    `exceptions[${index}]`,
  );
  const key = identityKey(checked.file, checked.names);
  if (required.get(key)?.kind !== checked.kind) {
    fail(`ambiguous exception ${key}`);
  }
  if (
    !["omitted", "skipped", "todo"].includes(item.status) ||
    typeof item.reason !== "string" ||
    item.reason.trim().length < 12 ||
    !exactKeys(item.applicability, ["platforms"]) ||
    !Array.isArray(item.applicability.platforms) ||
    item.applicability.platforms.length === 0 ||
    item.applicability.platforms.length >= platforms.size ||
    new Set(item.applicability.platforms).size !== item.applicability.platforms.length ||
    item.applicability.platforms.some((platform) => !platforms.has(platform))
  ) {
    fail(`exception ${key} needs exact status, reviewed reason, and platform subset`);
  }
  return item;
}

export function validateNodeTestContract(input: unknown): {
  required: Map<string, Identity>;
  exceptions: Map<string, Exception>;
} {
  if (!exactKeys(input, ["schemaVersion", "required", "exceptions"])) {
    fail("invalid contract fields");
  }
  const data = input as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(data.required) ||
    data.required.length === 0 ||
    !Array.isArray(data.exceptions)
  ) {
    fail("expected version 1 and a nonempty mandatory inventory");
  }
  const required = new Map<string, Identity>();
  for (const [index, raw] of data.required.entries()) {
    const item = identity(raw, `required[${index}]`);
    const key = identityKey(item.file, item.names);
    if (required.has(key)) {
      fail(`duplicate required identity ${key}`);
    }
    required.set(key, item);
  }
  const exceptions = new Map<string, Exception>();
  for (const [index, raw] of data.exceptions.entries()) {
    const item = checkedException(raw, index, required);
    const key = identityKey(item.file, item.names);
    if (exceptions.has(key)) {
      fail(`ambiguous exception ${key}`);
    }
    exceptions.set(key, item);
  }
  return { required, exceptions };
}
