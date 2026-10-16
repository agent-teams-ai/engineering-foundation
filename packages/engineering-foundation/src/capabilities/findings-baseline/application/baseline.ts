/** One finding class of one file. `max` is the largest measured value for rules that carry one. */
export interface Finding {
  readonly path: string;
  readonly rule: string;
  readonly count: number;
  readonly max?: number;
}

export type FindingViolationKind = "new" | "worse" | "stale";

export interface FindingViolation {
  readonly kind: FindingViolationKind;
  readonly path: string;
  readonly rule: string;
  readonly baseline?: Pick<Finding, "count" | "max">;
  readonly observed?: Pick<Finding, "count" | "max">;
}

export interface PrunedBaseline {
  readonly entries: readonly Finding[];
  readonly lowered: number;
  readonly removed: number;
  /** New and worse findings that pruning cannot accept; they keep failing the check. */
  readonly remaining: readonly FindingViolation[];
}

export class FindingsBaselineError extends Error {
  override readonly name = "FindingsBaselineError";
}

// UTF-16 code unit order, the order of compareBinaryStrings; only the consumers admitted by ADR-0047 may import that primitive.
export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const HEADER = '{"findingsBaseline":1}';
const RULE_PATTERN = /^[a-z0-9][a-z0-9-]*\/[^\s]+$/u;

function fail(message: string): never {
  throw new FindingsBaselineError(message);
}

function compareFindings(left: Pick<Finding, "path" | "rule">, right: Pick<Finding, "path" | "rule">): number {
  return compareText(left.path, right.path) || compareText(left.rule, right.rule);
}

function identity({ path, rule }: Pick<Finding, "path" | "rule">): string {
  return `${path}\u0000${rule}`;
}

function assertFinding(finding: Finding): void {
  const validPath = finding.path.length > 0 && finding.path.length <= 1024 &&
    !finding.path.startsWith("/") && !finding.path.includes("\\") &&
    finding.path.split("").every((character) => character >= " " && character !== "\u007f") &&
    finding.path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!validPath) { fail(`Finding path is not a repository-relative path: ${JSON.stringify(finding.path)}.`); }
  if (!RULE_PATTERN.test(finding.rule) || finding.rule.length > 200) {
    fail(`Finding rule must be "<namespace>/<rule>": ${JSON.stringify(finding.rule)}.`);
  }
  if (!Number.isSafeInteger(finding.count) || finding.count < 1) {
    fail(`Finding count must be a positive integer: ${finding.path} ${finding.rule}.`);
  }
  if (finding.max !== undefined && (!Number.isSafeInteger(finding.max) || finding.max < 0)) {
    fail(`Finding max must be a non-negative integer: ${finding.path} ${finding.rule}.`);
  }
}

function canonical(entries: readonly Finding[]): readonly Finding[] {
  const sorted = entries.toSorted(compareFindings);
  for (const [index, entry] of sorted.entries()) {
    assertFinding(entry);
    if (index > 0 && identity(sorted[index - 1] as Finding) === identity(entry)) {
      fail(`Duplicate finding: ${entry.path} ${entry.rule}.`);
    }
  }
  return sorted;
}

/** Canonical text: a version line, then one JSON object per path and rule in binary order. */
export function formatBaseline(entries: readonly Finding[]): string {
  const lines = canonical(entries).map(({ path, rule, count, max }) =>
    JSON.stringify(max === undefined ? { path, rule, count } : { path, rule, count, max }));
  return `${[HEADER, ...lines].join("\n")}\n`;
}

/** Rejects anything that is not exactly the canonical text, so a hand edit cannot hide a change. */
export function parseBaseline(text: string): readonly Finding[] {
  const lines = text.split("\n");
  if (lines[0] !== HEADER || lines.at(-1) !== "") { fail("Findings baseline must start with its version line and end with a newline."); }
  const entries = lines.slice(1, -1).map((line, index): Finding => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail(`Findings baseline line ${index + 2} is not JSON.`); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) { fail(`Findings baseline line ${index + 2} is not an object.`); }
    const { path, rule, count, max, ...unknown } = value as Record<string, unknown>;
    if (Object.keys(unknown).length > 0 || typeof path !== "string" || typeof rule !== "string" ||
      typeof count !== "number" || (max !== undefined && typeof max !== "number")) {
      fail(`Findings baseline line ${index + 2} has unexpected fields.`);
    }
    return max === undefined ? { path, rule, count } : { path, rule, count, max };
  });
  if (formatBaseline(entries) !== text) { fail("Findings baseline is not canonical: entries must be unique, sorted and one per line."); }
  return entries;
}

function scoped(findings: readonly Finding[], namespace: string): readonly Finding[] {
  return findings.filter(({ rule }) => rule.startsWith(`${namespace}/`));
}

function observedIn(namespace: string, observed: readonly Finding[]): ReadonlyMap<string, Finding> {
  for (const finding of canonical(observed)) {
    if (!finding.rule.startsWith(`${namespace}/`)) { fail(`Finding ${finding.rule} is outside the ${namespace} namespace.`); }
  }
  return new Map(observed.map((finding) => [identity(finding), finding]));
}

function exceeds(left: Pick<Finding, "count" | "max">, right: Pick<Finding, "count" | "max">): boolean {
  return left.count > right.count || (left.max ?? -1) > (right.max ?? -1);
}

const measure = ({ count, max }: Finding): Pick<Finding, "count" | "max"> => max === undefined ? { count } : { count, max };

/**
 * Compares the findings one producer observed with the baseline entries of its namespace.
 * A finding that is not baselined or is above its entry fails as new or worse; an entry above
 * the observed finding, or one without a finding, fails as stale. Other namespaces are not read.
 */
export function checkFindings(input: {
  readonly baseline: readonly Finding[];
  readonly observed: readonly Finding[];
  readonly namespace: string;
}): readonly FindingViolation[] {
  const observed = observedIn(input.namespace, input.observed);
  const entries = new Map(scoped(canonical(input.baseline), input.namespace).map((entry) => [identity(entry), entry]));
  const violations: FindingViolation[] = [];
  for (const [key, finding] of observed) {
    const entry = entries.get(key);
    if (entry === undefined) {
      violations.push({ kind: "new", path: finding.path, rule: finding.rule, observed: measure(finding) });
    } else if (exceeds(finding, entry)) {
      violations.push({ kind: "worse", path: finding.path, rule: finding.rule, baseline: measure(entry), observed: measure(finding) });
    } else if (exceeds(entry, finding)) {
      violations.push({ kind: "stale", path: finding.path, rule: finding.rule, baseline: measure(entry), observed: measure(finding) });
    }
  }
  for (const [key, entry] of entries) {
    if (!observed.has(key)) { violations.push({ kind: "stale", path: entry.path, rule: entry.rule, baseline: measure(entry) }); }
  }
  return violations.toSorted((left, right) => compareFindings(left, right));
}

/** Lowers entries to the observed values and removes entries without a finding. Never adds or raises. */
export function pruneBaseline(input: {
  readonly baseline: readonly Finding[];
  readonly observed: readonly Finding[];
  readonly namespace: string;
}): PrunedBaseline {
  const observed = observedIn(input.namespace, input.observed);
  const kept: Finding[] = [];
  let lowered = 0;
  let removed = 0;
  for (const entry of canonical(input.baseline)) {
    const finding = observed.get(identity(entry));
    if (!entry.rule.startsWith(`${input.namespace}/`)) {
      kept.push(entry);
    } else if (finding === undefined) {
      removed += 1;
    } else if (exceeds(entry, finding)) {
      const count = Math.min(entry.count, finding.count);
      const max = entry.max === undefined || finding.max === undefined ? undefined : Math.min(entry.max, finding.max);
      kept.push(max === undefined ? { path: entry.path, rule: entry.rule, count } : { path: entry.path, rule: entry.rule, count, max });
      lowered += 1;
    } else {
      kept.push(entry);
    }
  }
  const remaining = checkFindings({ baseline: kept, observed: input.observed, namespace: input.namespace })
    .filter(({ kind }) => kind !== "stale");
  return { entries: canonical(kept), lowered, removed, remaining };
}

/** The first baseline of a producer. Refuses when the baseline file already exists. */
export function initBaseline(input: { readonly observed: readonly Finding[]; readonly existing?: string }): readonly Finding[] {
  if (input.existing !== undefined) { fail("A findings baseline already exists; use prune to lower it."); }
  return canonical(input.observed);
}
