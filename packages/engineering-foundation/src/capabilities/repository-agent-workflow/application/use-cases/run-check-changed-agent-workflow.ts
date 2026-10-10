import { isCheckCancelled } from "../policies/check-cancellation.js";
import type { CheckChangedDependencies, CheckInputLease } from "../ports/check-changed.js";
import { CoverageExecutionFailure } from "../ports/check-changed.js";
import type { CheckChangedReport, CoverageRow, CoverageCheck, WorkflowCoveragePolicy } from "../model/check-changed.js";
import { planCheckCoverage } from "../policies/check-coverage.js";
import { readCapabilityInputProblem } from "../../../../features/validation-reporting/api.js";

export interface CheckChangedInput {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly baseRef?: string;
  readonly signal?: AbortSignal;
}
type Dependencies = Pick<CheckChangedDependencies, "custody" | "runner" | "loadPolicy">;
type Plan = ReturnType<typeof planCheckCoverage>;
interface ExecutionState {
  outcome: CheckChangedReport["outcome"];
  reason: string;
  readonly steps: CheckChangedReport["steps"][number][];
  readonly plannedChecks: CheckChangedReport["plannedChecks"][number][];
}
function custody(lease: CheckInputLease): CheckChangedReport["inputCustody"] {
  return {
    classification: lease.classification, sourceIdentity: lease.sourceIdentity,
    configIdentity: lease.configIdentity, closureIdentity: lease.closureIdentity,
    binding: lease.classification === "mutable" ? "unverified" : "qualified-host-precondition",
    limitation: "Host supplies complete influencing-closure custody for the check lifetime. Foundation does not enforce privileged-writer exclusion; scopeDigest identifies Git/path groups only."
  };
}
function emptyReport(lease: CheckInputLease, outcome: CheckChangedReport["outcome"], reason: string): CheckChangedReport {
  return Object.freeze({ reportSchemaVersion: 2, outcome, reason, source: null, base: null, head: null, scopeDigest: null, changeGroups: null, inputCustody: custody(lease), plannedChecks: [], steps: [], coverage: [] });
}
function covered(rows: readonly CoverageRow[], steps: CheckChangedReport["steps"]): readonly CoverageRow[] {
  return rows.map((row) => {
    const facet = row.facet;
    if (facet === null) { return row; }
    const ids = steps.filter((step) => row.checkIds.includes(step.id) && step.exitCode === 0 && !step.cancelled && step.qualifiedFacets.includes(facet)).map((step) => step.id);
    return ids.length === 0 ? row : { ...row, state: "checked", reason: "Successful qualified facet observation.", checkIds: ids };
  });
}
function failure(state: ExecutionState, outcome: ExecutionState["outcome"], reason: string): void {
  state.outcome = outcome; state.reason = reason;
}
function executionFailed(state: ExecutionState, check: CoverageCheck, error: unknown, signal?: AbortSignal): void {
  if (error instanceof CoverageExecutionFailure) {
    state.steps.push({ ...error.execution, id: check.id, script: check.script });
  }
  if (isCheckCancelled(signal)) { failure(state, "cancelled", "step-cancelled"); return; }
  const revoked = error instanceof CoverageExecutionFailure && error.admissionRevoked;
  failure(state, revoked ? "stale" : "failed", "step-admission-or-execution-failed");
}
function addEscalation(policy: WorkflowCoveragePolicy, plan: Plan, state: ExecutionState): void {
  if (state.plannedChecks.some((entry) => entry.id === policy.escalationCheck)) { return; }
  plan.selected.push(policy.escalationCheck);
  state.plannedChecks.push({ id: policy.escalationCheck, target: "repository", reason: "Confirmed empty test selection." });
  for (let index = 0; index < plan.rows.length; index++) {
    const row = plan.rows[index]!;
    if (row.facet !== null) { plan.rows[index] = { ...row, checkIds: [...row.checkIds, policy.escalationCheck] }; }
  }
}
async function runStep(check: CoverageCheck, input: CheckChangedInput, dependencies: Dependencies, lease: CheckInputLease, state: ExecutionState): Promise<boolean> {
  let result;
  try {
    result = await dependencies.runner.run({ lease, check, ...(input.signal === undefined ? {} : { signal: input.signal }) });
  } catch (error) {
    executionFailed(state, check, error, input.signal); return false;
  }
  state.steps.push({ ...result, id: check.id, script: check.script });
  if (result.cancelled || isCheckCancelled(input.signal) || result.observation?.outcome === "cancelled") {
    failure(state, "cancelled", "step-cancelled"); return false;
  }
  if (result.exitCode !== 0 || result.observation?.outcome === "failed") {
    failure(state, "failed", "step-failed"); return false;
  }
  return true;
}
function hasDeclaredFacets(policy: WorkflowCoveragePolicy, rows: readonly CoverageRow[]): boolean {
  return rows.every((row) => {
    const facet = row.facet;
    return facet === null || row.checkIds.some((id) => policy.checks.some((check) => check.id === id && check.supplies.includes(facet)));
  });
}
function hasSuccessfulCommands(plan: Plan, steps: CheckChangedReport["steps"]): boolean {
  return plan.selected.every((id) => steps.some((step) => step.id === id && step.exitCode === 0 && !step.cancelled && step.commands.some((command) => command.script === step.script && command.exitCode === 0)));
}
function concludeCoverage(policy: WorkflowCoveragePolicy, plan: Plan, lease: CheckInputLease, state: ExecutionState): void {
  if (state.outcome !== "uncovered") { return; }
  if (lease.classification === "mutable") {
    // Raw mutable feedback never qualifies facets. Missing declared mappings
    // still reject; matching hashes cannot prove check-lifetime bytes.
    if (hasDeclaredFacets(policy, plan.rows) && hasSuccessfulCommands(plan, state.steps)) {
      failure(state, "feedback-only", "mutable-input-binding-unverified");
    }
    return;
  }
  if (covered(plan.rows, state.steps).every((row) => row.state !== "uncovered")) {
    failure(state, "passed", "all-required-facets-observed");
  }
}
async function executePlan(context: { readonly input: CheckChangedInput; readonly dependencies: Dependencies }, policy: WorkflowCoveragePolicy, plan: Plan, lease: CheckInputLease, state: ExecutionState): Promise<void> {
  const { input, dependencies } = context;
  await lease.assertCurrent(input.signal);
  if (isCheckCancelled(input.signal)) { failure(state, "cancelled", "cancelled-before-checks"); return; }
  if (plan.selected.length === 0) { return; }
  failure(state, "uncovered", "required-facet-missing");
  for (const id of plan.selected) {
    await lease.assertCurrent(input.signal);
    if (isCheckCancelled(input.signal)) { failure(state, "cancelled", "cancelled-before-step"); break; }
    const check = policy.checks.find((entry) => entry.id === id)!;
    if (!await runStep(check, input, dependencies, lease, state)) { break; }
    // Only confirmed empty selection permits escalation. Missing/forged/no-op/
    // skipped observations and assertion failures never trigger a retry.
    if (state.steps.at(-1)?.observation?.outcome === "empty-selection") { addEscalation(policy, plan, state); }
  }
  concludeCoverage(policy, plan, lease, state);
}
function reportCoverage(plan: Plan, lease: CheckInputLease, state: ExecutionState): readonly CoverageRow[] {
  if (state.outcome === "stale" || state.outcome === "cancelled" || lease.classification === "mutable") {
    for (let index = 0; index < state.steps.length; index++) { state.steps[index] = { ...state.steps[index]!, qualifiedFacets: [] }; }
  }
  return covered(plan.rows, state.steps).map((row) => state.outcome === "stale" && row.facet !== null ? { ...row, state: "stale" as const, reason: "Input custody revoked." } : row);
}
export async function runCheckChangedAgentWorkflow(input: CheckChangedInput, dependencies: Dependencies): Promise<CheckChangedReport> {
  const lease = await dependencies.custody.acquire(input);
  try {
    let policy;
    try {
      policy = await dependencies.loadPolicy(lease.executionRoot, input.configPath, input.signal);
    } catch (error) {
      const problem = readCapabilityInputProblem(error);
      if (problem === undefined) { throw error; }
      return emptyReport(lease, "failed", problem.message);
    }
    if (isCheckCancelled(input.signal)) { return emptyReport(lease, "cancelled", "cancelled-before-scope-observation"); }
    const source = await lease.changesReader.collect({ consumerRoot: lease.executionRoot, ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    const plan = planCheckCoverage(policy, source.changedPaths);
    const state: ExecutionState = { outcome: "not-checked", reason: source.changedPaths.length === 0 ? "no-changes" : "all-paths-explicitly-excluded", steps: [], plannedChecks: plan.selected.map((id) => ({ id, target: "repository", reason: plan.unknown ? "Unknown path; safe repository escalation." : plan.missingFacet && id === policy.escalationCheck ? "Required facet missing; safe repository escalation." : "Consumer required repository facets." })) };
    try {
      await executePlan({ input, dependencies }, policy, plan, lease, state);
      await lease.assertCurrent(input.signal);
    } catch {
      failure(state, isCheckCancelled(input.signal) ? "cancelled" : "stale", "input-or-admission-revoked");
    }
    const coverage = reportCoverage(plan, lease, state);
    return Object.freeze({ reportSchemaVersion: 2, outcome: state.outcome, reason: state.reason, source,
      base: { requestedRef: source.requestedBaseRef, resolvedRef: source.resolvedBaseRef, commit: source.baseCommit, mergeBaseCommit: source.mergeBaseCommit },
      head: { ref: source.headRef, commit: source.headCommit }, scopeDigest: source.scopeDigest, changeGroups: source.changeGroups,
      inputCustody: custody(lease), plannedChecks: Object.freeze(state.plannedChecks), steps: Object.freeze(state.steps), coverage: Object.freeze(coverage) });
  } finally { await lease.release(); }
}
