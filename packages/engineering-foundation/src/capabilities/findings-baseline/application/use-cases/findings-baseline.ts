import {
  assertNotCancelled,
  CapabilityInputError,
  type FoundationDiagnostic,
} from "../../../../features/validation-reporting/api.js";
import {
  checkFindings,
  FindingsBaselineError,
  formatBaseline,
  initBaseline,
  parseBaseline,
  pruneBaseline,
  type Finding,
  type FindingViolation,
} from "../baseline.js";
import {
  OXLINT_NAMESPACE,
  type FindingsBaselineDependencies,
  type FindingsBaselinePolicy,
} from "../model.js";
import { FINDINGS_BASELINE_RULES } from "../rules.js";

interface Input {
  readonly consumerRoot: string;
  readonly policy: FindingsBaselinePolicy;
  readonly signal?: AbortSignal;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "findings-baseline-execution",
    retryable: false,
  });
}

function baselineEntries(text: string): readonly Finding[] {
  try {
    return parseBaseline(text);
  } catch (error) {
    if (error instanceof FindingsBaselineError) {
      inputError("FINDINGS_BASELINE_INVALID", error.message);
    }
    throw error;
  }
}

const measurement = (value: FindingViolation["observed"]): string =>
  value === undefined
    ? "none"
    : `${value.count}${value.max === undefined ? "" : ` (largest ${value.max})`}`;

function diagnostic(violation: FindingViolation): FoundationDiagnostic {
  const rule =
    violation.kind === "new"
      ? FINDINGS_BASELINE_RULES.newFinding
      : violation.kind === "worse"
        ? FINDINGS_BASELINE_RULES.worseFinding
        : FINDINGS_BASELINE_RULES.staleEntry;
  return {
    ruleId: rule.id,
    severity: rule.severity,
    subject: `${violation.path}:${violation.rule}`,
    message: `${violation.rule} in ${violation.path}: baseline ${measurement(violation.baseline)}, observed ${measurement(violation.observed)}.`,
    location: { path: violation.path },
    relatedLocations: [],
    evidence: [{ kind: "rule", value: violation.rule }],
    remediation: rule.remediation,
    requiresArchitectureReview: rule.requiresArchitectureReview,
  };
}

const readBaseline = (
  input: Input,
  dependencies: FindingsBaselineDependencies,
): Promise<string | undefined> =>
  dependencies.store.read(input.consumerRoot, input.policy.baselinePath, input.signal);

function missingBaseline(path: string): never {
  return inputError(
    "FINDINGS_BASELINE_MISSING",
    `Findings baseline ${path} does not exist; create it once with baseline init.`,
  );
}

async function observe(
  input: Input,
  dependencies: FindingsBaselineDependencies,
): Promise<readonly Finding[]> {
  const observed = await dependencies.producer.observe(input);
  assertNotCancelled(input.signal);
  return observed;
}

export async function checkFindingsBaseline(
  input: Input,
  dependencies: FindingsBaselineDependencies,
): Promise<readonly FoundationDiagnostic[]> {
  // A missing baseline fails before the expensive Oxlint run.
  const text =
    (await readBaseline(input, dependencies)) ?? missingBaseline(input.policy.baselinePath);
  const observed = await observe(input, dependencies);
  return checkFindings({
    baseline: baselineEntries(text),
    observed,
    namespace: OXLINT_NAMESPACE,
  }).map(diagnostic);
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
  dependencies: FindingsBaselineDependencies,
): Promise<FindingsBaselineWriteResult> {
  const path = input.policy.baselinePath;
  const text = await readBaseline(input, dependencies);
  if (input.action === "init") {
    // An existing baseline is refused before the expensive Oxlint run.
    if (text !== undefined) {
      inputError(
        "FINDINGS_BASELINE_EXISTS",
        `A findings baseline already exists; use prune to lower it. (${path})`,
      );
    }
    const entries = initBaseline({ observed: await observe(input, dependencies) });
    await dependencies.store.create(input.consumerRoot, path, formatBaseline(entries));
    return { action: "init", path, entries: entries.length, lowered: 0, removed: 0, remaining: [] };
  }
  if (text === undefined) {
    missingBaseline(path);
  }
  const observed = await observe(input, dependencies);
  const pruned = pruneBaseline({
    baseline: baselineEntries(text),
    observed,
    namespace: OXLINT_NAMESPACE,
  });
  const next = formatBaseline(pruned.entries);
  if (next !== text) {
    await dependencies.store.replace(input.consumerRoot, path, next, text);
  }
  return {
    action: "prune",
    path,
    entries: pruned.entries.length,
    lowered: pruned.lowered,
    removed: pruned.removed,
    remaining: pruned.remaining,
  };
}
