import {
  assertNotCancelled, CapabilityInputError, type FoundationDiagnostic
} from "../../../../features/validation-reporting/api.js";
import {
  checkFindings, FindingsBaselineError, formatBaseline, initBaseline, parseBaseline, pruneBaseline,
  type Finding, type FindingViolation
} from "../baseline.js";
import { OXLINT_NAMESPACE, type FindingsBaselineDependencies, type FindingsBaselinePolicy } from "../model.js";
import { FINDINGS_BASELINE_RULES } from "../rules.js";

interface Input {
  readonly consumerRoot: string;
  readonly policy: FindingsBaselinePolicy;
  readonly signal?: AbortSignal;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({ code, message, phase: "findings-baseline-execution", retryable: false });
}

function baselineEntries(text: string): readonly Finding[] {
  try { return parseBaseline(text); } catch (error) {
    if (error instanceof FindingsBaselineError) { inputError("FINDINGS_BASELINE_INVALID", error.message); }
    throw error;
  }
}

const measurement = (value: FindingViolation["observed"]): string =>
  value === undefined ? "none" : `${value.count}${value.max === undefined ? "" : ` (largest ${value.max})`}`;

function diagnostic(violation: FindingViolation): FoundationDiagnostic {
  const rule = violation.kind === "new" ? FINDINGS_BASELINE_RULES.newFinding
    : violation.kind === "worse" ? FINDINGS_BASELINE_RULES.worseFinding : FINDINGS_BASELINE_RULES.staleEntry;
  return {
    ruleId: rule.id,
    severity: rule.severity,
    subject: `${violation.path}:${violation.rule}`,
    message: `${violation.rule} in ${violation.path}: baseline ${measurement(violation.baseline)}, observed ${measurement(violation.observed)}.`,
    location: { path: violation.path },
    relatedLocations: [],
    evidence: [{ kind: "rule", value: violation.rule }],
    remediation: rule.remediation,
    requiresArchitectureReview: rule.requiresArchitectureReview
  };
}

async function load(input: Input, dependencies: FindingsBaselineDependencies): Promise<{ readonly text: string | undefined; readonly observed: readonly Finding[] }> {
  const text = await dependencies.store.read(input.consumerRoot, input.policy.baselinePath, input.signal);
  const observed = await dependencies.producer.observe(input);
  assertNotCancelled(input.signal);
  return { text, observed };
}

export async function checkFindingsBaseline(input: Input, dependencies: FindingsBaselineDependencies): Promise<readonly FoundationDiagnostic[]> {
  const { text, observed } = await load(input, dependencies);
  if (text === undefined) {
    inputError("FINDINGS_BASELINE_MISSING", `Findings baseline ${input.policy.baselinePath} does not exist; create it once with baseline init.`);
  }
  return checkFindings({ baseline: baselineEntries(text), observed, namespace: OXLINT_NAMESPACE }).map(diagnostic);
}

export interface FindingsBaselineWriteResult {
  readonly action: "init" | "prune";
  readonly path: string;
  readonly entries: number;
  readonly lowered: number;
  readonly removed: number;
  /** New and worse findings that the baseline does not accept. */
  readonly remaining: readonly FindingViolation[];
}

/** `init` writes the first baseline and refuses over an existing file; `prune` only lowers and removes entries. */
export async function writeFindingsBaseline(
  input: Input & { readonly action: "init" | "prune" },
  dependencies: FindingsBaselineDependencies
): Promise<FindingsBaselineWriteResult> {
  const { text, observed } = await load(input, dependencies);
  const path = input.policy.baselinePath;
  if (input.action === "init") {
    let entries: readonly Finding[];
    try { entries = initBaseline({ observed, ...(text === undefined ? {} : { existing: text }) }); } catch (error) {
      if (error instanceof FindingsBaselineError) { inputError("FINDINGS_BASELINE_EXISTS", `${error.message} (${path})`); }
      throw error;
    }
    await dependencies.store.create(input.consumerRoot, path, formatBaseline(entries));
    return { action: "init", path, entries: entries.length, lowered: 0, removed: 0, remaining: [] };
  }
  if (text === undefined) { inputError("FINDINGS_BASELINE_MISSING", `Findings baseline ${path} does not exist; create it once with baseline init.`); }
  const pruned = pruneBaseline({ baseline: baselineEntries(text), observed, namespace: OXLINT_NAMESPACE });
  const next = formatBaseline(pruned.entries);
  if (next !== text) { await dependencies.store.replace(input.consumerRoot, path, next, text); }
  return { action: "prune", path, entries: pruned.entries.length, lowered: pruned.lowered, removed: pruned.removed, remaining: pruned.remaining };
}
