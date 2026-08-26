import { classifySubjects, evaluateRelations, validateOverlay } from "./operations.js";

function deduplicateActions(results) {
  const actions = results.flatMap((entry) => entry.resolutions ?? [entry])
    .flatMap((entry) => entry.actions ?? []);
  return [...new Map(actions.map((entry) => [entry.semanticKey ?? `${entry.code}:${entry.targetId ?? ""}`, entry])).values()];
}

export function composedWorkflow({ snapshot, policy, subjects, relations, overlay, planId }) {
  const classification = classifySubjects({ snapshot, policy, subjects, planId });
  const assertions = classification.resolutions.flatMap((entry) => entry.assertion ? [entry.assertion] : []);
  const evaluation = evaluateRelations({
    snapshot,
    policy,
    candidates: relations,
    assertions,
    planId
  });
  const validation = validateOverlay({ snapshot, policy, overlay });
  return {
    workflow: "d5-composed-read-only@1",
    steps: { classification, evaluation, validation },
    nextActions: deduplicateActions([classification, evaluation, validation])
  };
}

export function preChangeComparison(scenario) {
  const overlayOnly = validateOverlay({
    snapshot: scenario.snapshot,
    policy: scenario.policy,
    overlay: undefined
  });
  const composed = composedWorkflow({
    snapshot: scenario.snapshot,
    policy: scenario.policy,
    subjects: scenario.subjects,
    relations: scenario.relations,
    overlay: undefined,
    planId: scenario.planId
  });
  const distinctActions = composed.nextActions
    .map((action) => action.code)
    .filter((code) => code !== "provide-overlay");
  return {
    overlayOnly,
    composed,
    distinctActions: [...new Set(distinctActions)],
    actionableGain: distinctActions.length > 0
  };
}
