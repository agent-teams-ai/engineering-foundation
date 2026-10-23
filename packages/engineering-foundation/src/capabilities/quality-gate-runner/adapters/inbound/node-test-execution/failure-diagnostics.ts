import { types } from "node:util";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// Developer output only. Every part is bounded by construction (fixed fields,
// at most 2 array items, one container level, capped text, 3-link cause chain), so the JSON
// is never sliced afterwards. Proxies are rejected before any reflection, and
// only own data descriptors are read: no getter, toJSON or inspect hook runs.
// The 8192 outer bound is met by fixed budgets, never by cutting the JSON.
// Cost model: one kept UTF-16 unit costs at most 6 output characters (JSON
// escapes a control character or lone surrogate as \uXXXX) and at most 6 bytes
// (an unescaped unit is at most 3). Text T(n) = 6n + 34: two quotes plus a
// marker of at most 32 ASCII characters. A field costs its key length + 4.
// name/code/operator/message admit only a capped string or a fixed marker
// ("[accessor omitted]" 22, "[non-string metadata]" 23 characters quoted), both
// below T(16); actual/expected admit a capped string, a number (at most 24), a
// fixed marker, or the array summary, none above V = 281 (items: T(12) = 106 at
// most, as numbers are 24 and markers at most 22).
// Per error level: name 8+T(16) + code 8+T(16) + operator 12+T(20) + message
// 11+T(48) + actual 10+V + expected 12+V + location 12+2+2xT(96)+1, where the
// array summary V = 68 + 2xT(12) + 1 = 281 covers a 40-unit string too (T(40) =
// 274) = 2,594, plus 2 braces. Three levels with two cause keys and a final
// cause marker: 3 x 2,596 + 18 + 30 = 7,836. The 96-unit test name line adds at
// most 327 characters or bytes, so each FAIL record stays at or below 8,163 < 8,192.
// This is a per-record guarantee only. QGR retains the final 8192 characters of
// combined stdout and stderr, so a near-maximal record shares that window with
// other failing records and the stderr contract line and can lose its head there.
const textLimit = 40;
const nestedTextLimit = 12;
const arrayItemLimit = 2;
export const testNameLimit = 96;
export function boundedText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}
// Frames keep their tail: the file:line:column the reader needs ends the line.
function tailText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `[truncated ${value.length - limit} chars]...${value.slice(-limit)}`;
}
function ownData(owner: object, key: string, depth: number, limit = textLimit): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) {
    return "[absent]";
  }
  return Object.hasOwn(descriptor, "value")
    ? boundedValue(descriptor.value as unknown, depth, limit)
    : "[accessor omitted]";
}
function boundedValue(value: unknown, depth: number, limit = textLimit): unknown {
  if (typeof value === "string") {
    return boundedText(value, depth === 0 ? limit : nestedTextLimit);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }
  if (types.isProxy(value)) {
    return "[proxy omitted]";
  }
  if (depth >= 1) {
    return "[depth limit]";
  }
  if (!Array.isArray(value)) {
    return "[object]";
  }
  const count = Math.min(value.length, arrayItemLimit);
  const items: unknown[] = [];
  for (let index = 0; index < count; index++) {
    items.push(ownData(value, String(index), depth + 1));
  }
  return value.length > count
    ? { type: "array", length: value.length, items, omitted: value.length - count }
    : { type: "array", length: value.length, items };
}
// Scalar-only metadata: a string is capped, anything else becomes a fixed marker
// without being inspected, so no array or object summary can enter these budgets.
function metadataField(descriptor: PropertyDescriptor, limit: number): string {
  if (!Object.hasOwn(descriptor, "value")) {
    return "[accessor omitted]";
  }
  const field = descriptor.value as unknown;
  return typeof field === "string" ? boundedText(field, limit) : "[non-string metadata]";
}
// Keep the source location separate: a long message must not push frames out.
// Returns undefined when there is no usable stack frame to report.
function stackLocation(value: object): unknown {
  const stack = Object.getOwnPropertyDescriptor(value, "stack");
  if (stack === undefined) {
    return undefined;
  }
  const stackText = Object.hasOwn(stack, "value") ? (stack.value as unknown) : undefined;
  if (stackText === undefined) {
    return "[accessor omitted]";
  }
  if (typeof stackText !== "string") {
    return undefined;
  }
  const start = stackText.indexOf("\n    at ");
  return start < 0
    ? undefined
    : stackText
        .slice(start + 1, start + 2049)
        .split("\n")
        .slice(0, 2)
        .map((line) => tailText(line.trim(), 96));
}
function failureDetail(value: unknown, depth = 0): unknown {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) {
    return boundedValue(value, 0);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, limit] of [
    ["name", 16],
    ["code", 16],
    ["operator", 20],
    ["message", 48],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined) {
      snapshot[key] = metadataField(descriptor, limit);
    }
  }
  for (const key of ["actual", "expected"]) {
    if (Object.hasOwn(value, key)) {
      snapshot[key] = ownData(value, key, 0);
    }
  }
  const location = stackLocation(value);
  if (location !== undefined) {
    snapshot.location = location;
  }
  const cause = Object.getOwnPropertyDescriptor(value, "cause");
  if (cause !== undefined) {
    if (!Object.hasOwn(cause, "value")) {
      snapshot.cause = "[accessor omitted]";
    } else {
      snapshot.cause =
        depth >= 2 ? "[cause depth limit]" : failureDetail(cause.value as unknown, depth + 1);
    }
  }
  return snapshot;
}
export function nodeTestFailureDetail(data: Record<string, unknown> | undefined): string {
  try {
    const details =
      data === undefined
        ? undefined
        : (Object.getOwnPropertyDescriptor(data, "details")?.value as unknown);
    const error = record(details)
      ? (Object.getOwnPropertyDescriptor(details, "error")?.value as unknown)
      : undefined;
    return JSON.stringify(failureDetail(error));
  } catch {
    // A diagnostic failure is visible but cannot replace the deterministic verdict.
    return "[failure diagnostic formatting failed]";
  }
}
