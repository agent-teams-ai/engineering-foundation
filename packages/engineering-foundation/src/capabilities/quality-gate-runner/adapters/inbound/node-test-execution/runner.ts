import { constants, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { run } from "node:test";
import { types } from "node:util";

type Identity = { file: string; names: string[]; kind: "suite" | "test" };
type Exception = Identity & { status: "omitted" | "skipped" | "todo"; reason: string;
  applicability: { platforms: string[] } };
type Event = { type: string; data?: Record<string, unknown> };
type Selected = { absolute: string; file: string };
type Entry = { file: string; name: string; kind: "suite" | "test"; id: number; parentId: number;
  enqueue: Record<string, unknown>; complete?: Record<string, unknown>; result?: Event };

const platforms = new Set(["darwin", "linux", "win32"]);
const identityKey = (file: string, names: readonly string[]): string => JSON.stringify([file, names]);
function fail(message: string): never { throw new Error(`Node test execution contract: ${message}`); }
function fileSnapshot(stat: { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
async function readContractFile(path: string): Promise<string> {
  // Keep the verified inode open while reading. NOFOLLOW blocks a final
  // symlink on POSIX; NONBLOCK prevents a FIFO from hanging before fstat.
  const flags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | flags).catch((error: unknown) => {
    if (record(error) && error.code === "ELOOP") { fail("contract must be a real regular file"); }
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() ||
      await realpath(path) !== path || fileSnapshot(await lstat(path, { bigint: true })) !== fileSnapshot(opened)) {
      fail("contract must be a real regular file");
    }
    const content = await handle.readFile("utf8");
    if (fileSnapshot(await handle.stat({ bigint: true })) !== fileSnapshot(opened) ||
      await realpath(path) !== path || fileSnapshot(await lstat(path, { bigint: true })) !== fileSnapshot(opened)) {
      fail("contract changed while reading");
    }
    return content;
  } finally {
    await handle.close();
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: unknown, fields: string[]): boolean {
  return record(value) && Object.keys(value).toSorted().join("\0") === fields.toSorted().join("\0");
}
function identity(value: unknown, label: string): Identity {
  if (!exactKeys(value, ["file", "names", "kind"])) { fail(`${label} has invalid fields`); }
  const item = value as Record<string, unknown>;
  if (typeof item.file !== "string" || item.file.length === 0 || item.file.includes("\\") ||
    item.file.startsWith("/") || item.file.includes("\0") || item.file !== item.file.normalize("NFC") ||
    item.file.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) {
    fail(`${label}.file must be a normalized relative entry path`);
  }
  if (!Array.isArray(item.names) || item.names.length === 0 ||
    item.names.some((name: unknown) => typeof name !== "string" || name.length === 0 || name.includes("\0"))) {
    fail(`${label}.names must contain full nonempty ancestry`);
  }
  if (item.kind !== "suite" && item.kind !== "test") { fail(`${label}.kind must be suite or test`); }
  return item as Identity;
}

function checkedException(raw: unknown, index: number, required: Map<string, Identity>): Exception {
  if (!exactKeys(raw, ["file", "names", "kind", "status", "reason", "applicability"])) {
    fail(`exceptions[${index}] has invalid fields`);
  }
  const item = raw as Exception;
  const checked = identity({ file: item.file, names: item.names, kind: item.kind }, `exceptions[${index}]`);
  const key = identityKey(checked.file, checked.names);
  if (required.get(key)?.kind !== checked.kind) { fail(`ambiguous exception ${key}`); }
  if (!["omitted", "skipped", "todo"].includes(item.status) ||
    typeof item.reason !== "string" || item.reason.trim().length < 12 ||
    !exactKeys(item.applicability, ["platforms"]) || !Array.isArray(item.applicability.platforms) ||
    item.applicability.platforms.length === 0 || item.applicability.platforms.length >= platforms.size ||
    new Set(item.applicability.platforms).size !== item.applicability.platforms.length ||
    item.applicability.platforms.some((platform) => !platforms.has(platform))) {
    fail(`exception ${key} needs exact status, reviewed reason, and platform subset`);
  }
  return item;
}

export function validateNodeTestContract(input: unknown):
  { required: Map<string, Identity>; exceptions: Map<string, Exception> } {
  if (!exactKeys(input, ["schemaVersion", "required", "exceptions"])) { fail("invalid contract fields"); }
  const data = input as Record<string, unknown>;
  if (data.schemaVersion !== 1 || !Array.isArray(data.required) || data.required.length === 0 ||
    !Array.isArray(data.exceptions)) { fail("expected version 1 and a nonempty mandatory inventory"); }
  const required = new Map<string, Identity>();
  for (const [index, raw] of data.required.entries()) {
    const item = identity(raw, `required[${index}]`);
    const key = identityKey(item.file, item.names);
    if (required.has(key)) { fail(`duplicate required identity ${key}`); }
    required.set(key, item);
  }
  const exceptions = new Map<string, Exception>();
  for (const [index, raw] of data.exceptions.entries()) {
    const item = checkedException(raw, index, required);
    const key = identityKey(item.file, item.names);
    if (exceptions.has(key)) { fail(`ambiguous exception ${key}`); }
    exceptions.set(key, item);
  }
  return { required, exceptions };
}

async function selectFiles(root: string, files: string[]): Promise<Selected[]> {
  if (!Array.isArray(files) || files.length === 0) { fail("selected files must be nonempty"); }
  const selected: Selected[] = [];
  const seen = new Set<string>();
  for (const path of files) {
    if (typeof path !== "string" || path.length === 0) { fail("selected file must be a path"); }
    const absolute = resolve(root, path);
    const file = relative(root, absolute).split(sep).join("/");
    if (!file || file.startsWith("../") || isAbsolute(file) || file.includes("\\") ||
      file !== file.normalize("NFC") || seen.has(file)) {
      fail(`invalid selected file ${path}`);
    }
    seen.add(file);
    if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute) {
      fail(`selected file is not a real entry file: ${file}`);
    }
    selected.push({ absolute, file });
  }
  return selected;
}

function checkEvent(data: Record<string, unknown>, label: string): void {
  if (typeof data.entryFile !== "string" || !Number.isSafeInteger(data.testId) || (data.testId as number) < 1 ||
    !Number.isSafeInteger(data.parentId) || (data.parentId as number) < 0 ||
    typeof data.name !== "string" || data.name.length === 0) { fail(`malformed ${label} event`); }
}

function directiveActive(data: Record<string, unknown> | undefined, name: "skip" | "todo" | "expectFailure"): boolean {
  if (data === undefined || !Object.hasOwn(data, name)) { return false; }
  const value = data[name];
  if (typeof value === "string") { return true; }
  if (typeof value === "boolean") { return value; }
  fail(`malformed ${name} directive`);
}

function checkDirectives(data: Record<string, unknown>): void {
  const skipped = directiveActive(data, "skip");
  const todo = directiveActive(data, "todo");
  if (directiveActive(data, "expectFailure")) {
    fail("expected failure cannot qualify as passing test execution");
  }
  if (skipped && todo) {
    fail("conflicting skip and todo directives");
  }
}

type Evidence = { selected: Set<string>; entries: Map<string, Entry>; summaries: Map<string, boolean>;
  finalSummary?: boolean };

function collectSummary(data: Record<string, unknown>, evidence: Evidence): void {
  if (data.entryFile === undefined) {
    if (evidence.finalSummary !== undefined || typeof data.success !== "boolean") {
      fail("duplicate or malformed final summary");
    }
    evidence.finalSummary = data.success;
    return;
  }
  if (typeof data.entryFile !== "string" || !evidence.selected.has(data.entryFile) ||
    evidence.summaries.has(data.entryFile) || typeof data.success !== "boolean") {
    fail("malformed, duplicate, or foreign file summary");
  }
  evidence.summaries.set(data.entryFile, data.success);
}

function collectResult(event: Event, data: Record<string, unknown>, evidence: Evidence): void {
  checkEvent(data, event.type);
  if (!evidence.selected.has(data.entryFile as string)) { fail("event belongs to an unselected file"); }
  const key = `${String(data.entryFile)}\0${String(data.testId)}`;
  if (event.type === "test:enqueue") {
    if (evidence.entries.has(key) || (data.type !== "test" && data.type !== "suite")) {
      fail("duplicate or malformed enqueue");
    }
    evidence.entries.set(key, { file: data.entryFile as string, name: data.name as string,
      kind: data.type, id: data.testId as number, parentId: data.parentId as number, enqueue: data });
    return;
  }
  const entry = evidence.entries.get(key);
  if (entry === undefined) { fail("result lacks matching registration"); }
  if (entry.name !== data.name || entry.parentId !== data.parentId) { fail("result does not match registration"); }
  if (event.type === "test:complete") {
    if (entry.complete || !record(data.details) || data.details.type !== entry.kind ||
      typeof data.details.passed !== "boolean") { fail("duplicate or malformed completion"); }
    entry.complete = data;
    return;
  }
  if (entry.result || !record(data.details) || data.details.type !== entry.kind) {
    fail("duplicate or malformed result");
  }
  entry.result = event;
}

function collectEvent(event: Event, evidence: Evidence): void {
  const data = event.data;
  if (record(data)) { checkDirectives(data); }
  if (event.type === "test:summary") {
    if (!record(data)) { fail("malformed summary"); }
    if (directiveActive(data, "skip") || directiveActive(data, "todo")) {
      fail("directive outside a test identity");
    }
    collectSummary(data, evidence);
    return;
  }
  if (!["test:enqueue", "test:complete", "test:pass", "test:fail"].includes(event.type)) {
    if (record(data) && (directiveActive(data, "skip") || directiveActive(data, "todo"))) {
      fail("directive outside a test identity");
    }
    return;
  }
  if (!record(data)) { fail(`malformed ${event.type} event`); }
  if (data.entryFile === undefined) {
    // The Node runner's outer file wrapper is not a test identity.
    if (typeof data.file !== "string" || !evidence.selected.has(data.file) ||
      data.name !== data.file || data.parentId !== 0) { fail(`unattributed ${event.type} event`); }
    if (directiveActive(data, "skip") || directiveActive(data, "todo")) {
      fail("directive outside a test identity");
    }
    if (event.type === "test:fail") { fail(`failed entry file: ${data.file}`); }
    return;
  }
  collectResult(event, data, evidence);
}

function fullNames(entry: Entry, entries: Map<string, Entry>): string[] {
  const names = [entry.name];
  const visited = new Set([entry.id]);
  let parentId = entry.parentId;
  while (parentId !== 0) {
    if (visited.has(parentId)) { fail("cyclic ancestry"); }
    visited.add(parentId);
    const parent = entries.get(`${entry.file}\0${parentId}`);
    if (parent === undefined) { fail("missing test or suite ancestry"); }
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names;
}

function observedEntries(entries: Map<string, Entry>): Map<string, Entry> {
  const observed = new Map<string, Entry>();
  for (const entry of entries.values()) {
    if (!entry.complete || !entry.result) { fail("registered identity lacks completion and result"); }
    const key = identityKey(entry.file, fullNames(entry, entries));
    if (observed.has(key)) { fail(`ambiguous duplicate identity ${key}`); }
    observed.set(key, entry);
    if (entry.result.type === "test:fail" || (entry.complete.details as Record<string, unknown>).passed !== true) {
      fail(`failed test execution: ${key}`);
    }
    outcomeOf(entry, entry.kind);
  }
  return observed;
}

function outcomeOf(entry: Entry | undefined, kind: Identity["kind"]): string {
  if (entry === undefined) { return "omitted"; }
  if (entry.kind !== kind) { return "wrong-kind"; }
  const skipped = directiveActive(entry.enqueue, "skip") ||
    directiveActive(entry.result?.data, "skip") || directiveActive(entry.complete, "skip");
  const todo = directiveActive(entry.enqueue, "todo") ||
    directiveActive(entry.result?.data, "todo") || directiveActive(entry.complete, "todo");
  if (skipped && todo) { fail("conflicting skip and todo directives"); }
  if (skipped) { return "skipped"; }
  if (todo) { return "todo"; }
  return "passed";
}

function requireExecutedAncestors(item: Identity, absolute: string, observed: Map<string, Entry>, key: string): void {
  for (let length = 1; length < item.names.length; length++) {
    const ancestor = observed.get(identityKey(absolute, item.names.slice(0, length)));
    if (ancestor && outcomeOf(ancestor, ancestor.kind) !== "passed") {
      fail(`required identity has an unexecuted ancestor: ${key}`);
    }
  }
}

function countProtected(required: Map<string, Identity>, exceptions: Map<string, Exception>,
  selectedFiles: Selected[], observed: Map<string, Entry>, platform: string): number {
  let count = 0;
  const failures: string[] = [];
  for (const [key, item] of required) {
    const absolute = selectedFiles.find((file) => file.file === item.file)?.absolute;
    if (absolute === undefined) { continue; }
    count++;
    requireExecutedAncestors(item, absolute, observed, key);
    const outcome = outcomeOf(observed.get(identityKey(absolute, item.names)), item.kind);
    if (outcome === "passed") { continue; }
    const exception = exceptions.get(key);
    if (exception?.status === outcome && exception.applicability.platforms.includes(platform)) { continue; }
    failures.push(`${key}: ${outcome}`);
  }
  if (count === 0) { fail("selection contains no mandatory identities"); }
  if (failures.length > 0) { fail(`required execution failed: ${failures.join("; ")}`); }
  return count;
}

export function evaluateNodeTestEvents(events: Event[], contract: unknown, selectedFiles: Selected[], platform = process.platform):
  { protectedCount: number; observedCount: number; selectedFileCount: number } {
  const { required, exceptions } = validateNodeTestContract(contract);
  const selected = new Set(selectedFiles.map((item) => item.absolute));
  if (selected.size !== selectedFiles.length || selected.size === 0) { fail("invalid selected file evidence"); }
  const evidence: Evidence = { selected, entries: new Map(), summaries: new Map() };
  for (const event of events) { collectEvent(event, evidence); }
  if (evidence.finalSummary === undefined || evidence.summaries.size !== selected.size) {
    fail("missing final or file summary");
  }
  const observed = observedEntries(evidence.entries);
  const protectedCount = countProtected(required, exceptions, selectedFiles, observed, platform);
  if (!evidence.finalSummary || [...evidence.summaries.values()].some((success) => !success)) {
    fail("test summary reports unsuccessful execution");
  }
  return { protectedCount, observedCount: observed.size, selectedFileCount: selected.size };
}

export function assertSupportedNodeTestRuntime(version = process.versions.node): void {
  const [major, minor, patch] = version.split(".").map(Number);
  const node24 = major === 24 && minor !== undefined && Number.isSafeInteger(minor) && minor >= 21;
  const node26 = major === 26 && minor !== undefined && Number.isSafeInteger(minor) && minor >= 0;
  if ((!node24 && !node26) || patch === undefined || !Number.isSafeInteger(patch) || patch < 0) {
    fail("requires Node >=24.21.0 <25 or >=26.0.0 <27");
  }
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
const testNameLimit = 96;
function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}
// Frames keep their tail: the file:line:column the reader needs ends the line.
function tailText(value: string, limit: number): string {
  return value.length <= limit ? value : `[truncated ${value.length - limit} chars]...${value.slice(-limit)}`;
}
function ownData(owner: object, key: string, depth: number, limit = textLimit): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) { return "[absent]"; }
  return Object.hasOwn(descriptor, "value") ? boundedValue(descriptor.value as unknown, depth, limit) : "[accessor omitted]";
}
function boundedValue(value: unknown, depth: number, limit = textLimit): unknown {
  if (typeof value === "string") { return boundedText(value, depth === 0 ? limit : nestedTextLimit); }
  if (value === null || typeof value === "boolean") { return value; }
  if (typeof value === "number") { return Number.isFinite(value) ? value : String(value); }
  if (typeof value !== "object") { return `[${typeof value}]`; }
  if (types.isProxy(value)) { return "[proxy omitted]"; }
  if (depth >= 1) { return "[depth limit]"; }
  if (!Array.isArray(value)) { return "[object]"; }
  const count = Math.min(value.length, arrayItemLimit);
  const items: unknown[] = [];
  for (let index = 0; index < count; index++) { items.push(ownData(value, String(index), depth + 1)); }
  return value.length > count ? { type: "array", length: value.length, items, omitted: value.length - count }
    : { type: "array", length: value.length, items };
}
// Scalar-only metadata: a string is capped, anything else becomes a fixed marker
// without being inspected, so no array or object summary can enter these budgets.
function metadataField(descriptor: PropertyDescriptor, limit: number): string {
  if (!Object.hasOwn(descriptor, "value")) { return "[accessor omitted]"; }
  const field = descriptor.value as unknown;
  return typeof field === "string" ? boundedText(field, limit) : "[non-string metadata]";
}
// Keep the source location separate: a long message must not push frames out.
// Returns undefined when there is no usable stack frame to report.
function stackLocation(value: object): unknown {
  const stack = Object.getOwnPropertyDescriptor(value, "stack");
  if (stack === undefined) { return undefined; }
  const stackText = Object.hasOwn(stack, "value") ? stack.value as unknown : undefined;
  if (stackText === undefined) { return "[accessor omitted]"; }
  if (typeof stackText !== "string") { return undefined; }
  const start = stackText.indexOf("\n    at ");
  return start < 0 ? undefined : stackText.slice(start + 1, start + 2049).split("\n").slice(0, 2)
    .map((line) => tailText(line.trim(), 96));
}
function failureDetail(value: unknown, depth = 0): unknown {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) {
    return boundedValue(value, 0);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, limit] of [["name", 16], ["code", 16], ["operator", 20], ["message", 48]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined) { snapshot[key] = metadataField(descriptor, limit); }
  }
  for (const key of ["actual", "expected"]) {
    if (Object.hasOwn(value, key)) { snapshot[key] = ownData(value, key, 0); }
  }
  const location = stackLocation(value);
  if (location !== undefined) { snapshot.location = location; }
  const cause = Object.getOwnPropertyDescriptor(value, "cause");
  if (cause !== undefined) {
    if (!Object.hasOwn(cause, "value")) { snapshot.cause = "[accessor omitted]"; }
    else { snapshot.cause = depth >= 2 ? "[cause depth limit]" : failureDetail(cause.value as unknown, depth + 1); }
  }
  return snapshot;
}
function nodeTestFailureDetail(data: Record<string, unknown> | undefined): string {
  try {
    const details = data === undefined ? undefined : Object.getOwnPropertyDescriptor(data, "details")?.value as unknown;
    const error = record(details) ? Object.getOwnPropertyDescriptor(details, "error")?.value as unknown : undefined;
    return JSON.stringify(failureDetail(error));
  } catch {
    // A diagnostic failure is visible but cannot replace the deterministic verdict.
    return "[failure diagnostic formatting failed]";
  }
}

export async function runNodeTestExecution({ root = process.cwd(), files, contractPath, runOptions = {}, output = process.stdout }:
  { root?: string; files: string[]; contractPath: string; runOptions?: NonNullable<Parameters<typeof run>[0]>;
    output?: NodeJS.WritableStream }): Promise<{ protectedCount: number; observedCount: number; selectedFileCount: number }> {
  assertSupportedNodeTestRuntime();
  // Canonicalize a root alias (for example macOS /var -> /private/var) before
  // checking entry files. Individual entry-file symlinks remain forbidden.
  const absoluteRoot = await realpath(resolve(root));
  const selected = await selectFiles(absoluteRoot, files);
  if (typeof contractPath !== "string" || contractPath.length === 0 || isAbsolute(contractPath) ||
    contractPath.includes("\\") || contractPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("contract path must be a normalized relative file");
  }
  const absoluteContract = resolve(absoluteRoot, contractPath);
  const contract = JSON.parse(await readContractFile(absoluteContract)) as unknown;
  const { required } = validateNodeTestContract(contract);
  if (!selected.some((file) => [...required.values()].some((item) => item.file === file.file))) {
    fail("selection contains no mandatory identities");
  }
  const events: Event[] = [];
  for await (const event of run({ ...runOptions, cwd: absoluteRoot, files: selected.map((file) => file.absolute), concurrency: 1 })) {
    const observed = event as Event;
    events.push(observed);
    if (observed.type === "test:fail") { output.write(`FAIL ${boundedText(String(observed.data?.name), testNameLimit)}\n${nodeTestFailureDetail(observed.data)}\n`); }
  }
  const result = evaluateNodeTestEvents(events, contract, selected);
  output.write(`Mandatory Node tests: ${result.protectedCount} required identities completed or exactly excepted\n`);
  return result;
}
