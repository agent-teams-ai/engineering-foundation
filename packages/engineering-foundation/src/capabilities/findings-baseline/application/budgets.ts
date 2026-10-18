import { compareText, FindingsBaselineError } from "./baseline.js";

export interface Measurement {
  readonly subject: string;
  readonly metric: string;
  readonly value: number;
}

/** A ceiling for a metric. A threshold with a `subject` replaces the general threshold of that metric for the subject. */
export interface Threshold {
  readonly metric: string;
  readonly max: number;
  readonly subject?: string;
}

export interface BudgetWarning extends Measurement {
  readonly max: number;
}

function assertBudgetInput(measurements: readonly Measurement[], thresholds: readonly Threshold[]): void {
  const seen = new Set<string>();
  for (const { metric, subject, max } of thresholds) {
    const key = `${metric}\u0000${subject ?? ""}\u0000${subject === undefined}`;
    if (seen.has(key)) { throw new FindingsBaselineError(`Threshold for ${metric}${subject === undefined ? "" : ` of ${subject}`} is declared more than once.`); }
    seen.add(key);
    if (!Number.isFinite(max)) { throw new FindingsBaselineError(`Threshold max for ${metric} must be a finite number.`); }
  }
  for (const { subject, metric, value } of measurements) {
    if (!Number.isFinite(value)) { throw new FindingsBaselineError(`Measurement ${metric} of ${subject} must be a finite number.`); }
  }
}

/** Growth budgets only warn; they never fail a check. Duplicate thresholds and non-finite numbers are rejected. */
export function checkBudgets(input: {
  readonly measurements: readonly Measurement[];
  readonly thresholds: readonly Threshold[];
}): readonly BudgetWarning[] {
  assertBudgetInput(input.measurements, input.thresholds);
  const warnings: BudgetWarning[] = [];
  for (const measurement of input.measurements) {
    const matching = input.thresholds.filter(({ metric }) => metric === measurement.metric);
    const threshold = matching.find(({ subject }) => subject === measurement.subject) ?? matching.find(({ subject }) => subject === undefined);
    if (threshold !== undefined && measurement.value > threshold.max) { warnings.push({ ...measurement, max: threshold.max }); }
  }
  return warnings.toSorted((left, right) => compareText(left.subject, right.subject) || compareText(left.metric, right.metric));
}

const escapeData = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value: string): string => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** GitHub Actions workflow commands, one warning annotation per budget warning. */
export function formatBudgetAnnotations(warnings: readonly BudgetWarning[]): string {
  return warnings.map(({ subject, metric, value, max }) =>
    `::warning title=${escapeProperty(`${metric} budget`)}::${escapeData(`${subject}: ${metric} is ${value}, budget ${max}`)}\n`).join("");
}
