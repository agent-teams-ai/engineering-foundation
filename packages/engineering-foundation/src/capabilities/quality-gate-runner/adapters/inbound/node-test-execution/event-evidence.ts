import { fail, record, identityKey, type Identity, type Exception } from "./contract-validation.js";
export type Event = { type: string; data?: Record<string, unknown> };
export type Selected = { absolute: string; file: string };
type Entry = {
  file: string;
  name: string;
  kind: "suite" | "test";
  id: number;
  parentId: number;
  enqueue: Record<string, unknown>;
  complete?: Record<string, unknown>;
  result?: Event;
};

function checkEvent(data: Record<string, unknown>, label: string): void {
  if (
    typeof data.entryFile !== "string" ||
    !Number.isSafeInteger(data.testId) ||
    (data.testId as number) < 1 ||
    !Number.isSafeInteger(data.parentId) ||
    (data.parentId as number) < 0 ||
    typeof data.name !== "string" ||
    data.name.length === 0
  ) {
    fail(`malformed ${label} event`);
  }
}

function directiveActive(
  data: Record<string, unknown> | undefined,
  name: "skip" | "todo" | "expectFailure",
): boolean {
  if (data === undefined || !Object.hasOwn(data, name)) {
    return false;
  }
  const value = data[name];
  if (typeof value === "string") {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }
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

export type Evidence = {
  selected: Set<string>;
  entries: Map<string, Entry>;
  summaries: Map<string, boolean>;
  finalSummary?: boolean;
};

function collectSummary(data: Record<string, unknown>, evidence: Evidence): void {
  if (data.entryFile === undefined) {
    if (evidence.finalSummary !== undefined || typeof data.success !== "boolean") {
      fail("duplicate or malformed final summary");
    }
    evidence.finalSummary = data.success;
    return;
  }
  if (
    typeof data.entryFile !== "string" ||
    !evidence.selected.has(data.entryFile) ||
    evidence.summaries.has(data.entryFile) ||
    typeof data.success !== "boolean"
  ) {
    fail("malformed, duplicate, or foreign file summary");
  }
  evidence.summaries.set(data.entryFile, data.success);
}

function collectResult(event: Event, data: Record<string, unknown>, evidence: Evidence): void {
  checkEvent(data, event.type);
  if (!evidence.selected.has(data.entryFile as string)) {
    fail("event belongs to an unselected file");
  }
  const key = `${String(data.entryFile)}\0${String(data.testId)}`;
  if (event.type === "test:enqueue") {
    if (evidence.entries.has(key) || (data.type !== "test" && data.type !== "suite")) {
      fail("duplicate or malformed enqueue");
    }
    evidence.entries.set(key, {
      file: data.entryFile as string,
      name: data.name as string,
      kind: data.type,
      id: data.testId as number,
      parentId: data.parentId as number,
      enqueue: data,
    });
    return;
  }
  const entry = evidence.entries.get(key);
  if (entry === undefined) {
    fail("result lacks matching registration");
  }
  if (entry.name !== data.name || entry.parentId !== data.parentId) {
    fail("result does not match registration");
  }
  if (event.type === "test:complete") {
    if (
      entry.complete ||
      !record(data.details) ||
      data.details.type !== entry.kind ||
      typeof data.details.passed !== "boolean"
    ) {
      fail("duplicate or malformed completion");
    }
    entry.complete = data;
    return;
  }
  if (entry.result || !record(data.details) || data.details.type !== entry.kind) {
    fail("duplicate or malformed result");
  }
  entry.result = event;
}

export function collectEvent(event: Event, evidence: Evidence): void {
  const data = event.data;
  if (record(data)) {
    checkDirectives(data);
  }
  if (event.type === "test:summary") {
    if (!record(data)) {
      fail("malformed summary");
    }
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
  if (!record(data)) {
    fail(`malformed ${event.type} event`);
  }
  if (data.entryFile === undefined) {
    // The Node runner's outer file wrapper is not a test identity.
    if (
      typeof data.file !== "string" ||
      !evidence.selected.has(data.file) ||
      data.name !== data.file ||
      data.parentId !== 0
    ) {
      fail(`unattributed ${event.type} event`);
    }
    if (directiveActive(data, "skip") || directiveActive(data, "todo")) {
      fail("directive outside a test identity");
    }
    if (event.type === "test:fail") {
      fail(`failed entry file: ${data.file}`);
    }
    return;
  }
  collectResult(event, data, evidence);
}

function fullNames(entry: Entry, entries: Map<string, Entry>): string[] {
  const names = [entry.name];
  const visited = new Set([entry.id]);
  let parentId = entry.parentId;
  while (parentId !== 0) {
    if (visited.has(parentId)) {
      fail("cyclic ancestry");
    }
    visited.add(parentId);
    const parent = entries.get(`${entry.file}\0${parentId}`);
    if (parent === undefined) {
      fail("missing test or suite ancestry");
    }
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names;
}

export function observedEntries(entries: Map<string, Entry>): Map<string, Entry> {
  const observed = new Map<string, Entry>();
  for (const entry of entries.values()) {
    if (!entry.complete || !entry.result) {
      fail("registered identity lacks completion and result");
    }
    const key = identityKey(entry.file, fullNames(entry, entries));
    if (observed.has(key)) {
      fail(`ambiguous duplicate identity ${key}`);
    }
    observed.set(key, entry);
    if (
      entry.result.type === "test:fail" ||
      (entry.complete.details as Record<string, unknown>).passed !== true
    ) {
      fail(`failed test execution: ${key}`);
    }
    outcomeOf(entry, entry.kind);
  }
  return observed;
}

function outcomeOf(entry: Entry | undefined, kind: Identity["kind"]): string {
  if (entry === undefined) {
    return "omitted";
  }
  if (entry.kind !== kind) {
    return "wrong-kind";
  }
  const skipped =
    directiveActive(entry.enqueue, "skip") ||
    directiveActive(entry.result?.data, "skip") ||
    directiveActive(entry.complete, "skip");
  const todo =
    directiveActive(entry.enqueue, "todo") ||
    directiveActive(entry.result?.data, "todo") ||
    directiveActive(entry.complete, "todo");
  if (skipped && todo) {
    fail("conflicting skip and todo directives");
  }
  if (skipped) {
    return "skipped";
  }
  if (todo) {
    return "todo";
  }
  return "passed";
}

function requireExecutedAncestors(
  item: Identity,
  absolute: string,
  observed: Map<string, Entry>,
  key: string,
): void {
  for (let length = 1; length < item.names.length; length++) {
    const ancestor = observed.get(identityKey(absolute, item.names.slice(0, length)));
    if (ancestor && outcomeOf(ancestor, ancestor.kind) !== "passed") {
      fail(`required identity has an unexecuted ancestor: ${key}`);
    }
  }
}

export function countProtected(
  required: Map<string, Identity>,
  exceptions: Map<string, Exception>,
  selectedFiles: Selected[],
  observed: Map<string, Entry>,
  platform: string,
): number {
  let count = 0;
  const failures: string[] = [];
  for (const [key, item] of required) {
    const absolute = selectedFiles.find((file) => file.file === item.file)?.absolute;
    if (absolute === undefined) {
      continue;
    }
    count++;
    requireExecutedAncestors(item, absolute, observed, key);
    const outcome = outcomeOf(observed.get(identityKey(absolute, item.names)), item.kind);
    if (outcome === "passed") {
      continue;
    }
    const exception = exceptions.get(key);
    if (exception?.status === outcome && exception.applicability.platforms.includes(platform)) {
      continue;
    }
    failures.push(`${key}: ${outcome}`);
  }
  if (count === 0) {
    fail("selection contains no mandatory identities");
  }
  if (failures.length > 0) {
    fail(`required execution failed: ${failures.join("; ")}`);
  }
  return count;
}
