import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifySubjects, evaluateRelations, operationVersions, validateOverlay } from "../src/operations.js";
import { composedWorkflow, preChangeComparison } from "../src/workflow.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scenarios = JSON.parse(await readFile(join(root, "fixtures", "scenarios.json"), "utf8"));
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
const clone = (value) => structuredClone(value);

function assertionsFrom(classification) {
  return classification.resolutions.flatMap((entry) => entry.assertion ? [entry.assertion] : []);
}

test("fixture matrix matches the strengthened preregistered outcomes", () => {
  for (const scenario of scenarios) {
    const comparison = preChangeComparison(scenario);
    const overlay = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay });
    assert.equal(comparison.actionableGain, scenario.expected.actionableGain, scenario.id);
    assert.equal(overlay.resolution, scenario.expected.overlayResolution, scenario.id);
    assert.equal(overlay.verdict ?? null, scenario.expected.overlayVerdict, scenario.id);
    assert.equal(overlay.reason, scenario.expected.overlayReason, scenario.id);
    if (overlay.resolution === "decided") assert.match(overlay.verdict, /^(pass|fail)$/);
  }
});

test("the preserved decision rule still passes with the declared representative gains", () => {
  const gains = scenarios.filter((scenario) => scenario.representative && preChangeComparison(scenario).actionableGain);
  assert.ok(gains.length >= 2);
  assert.deepEqual(gains.map((scenario) => scenario.id), [
    "unknown-subject", "planned-vs-observed-relation", "mixed-outcomes", "incomplete-observation"
  ]);
});

test("planned and observed identity is bound on every classification and relation resolution", () => {
  const scenario = byId.get("planned-vs-observed-relation");
  const classification = classifySubjects({ ...scenario, planId: scenario.planId });
  const evaluation = evaluateRelations({ ...scenario, candidates: scenario.relations,
    assertions: assertionsFrom(classification), planId: scenario.planId });
  assert.ok(classification.resolutions.every((entry) => entry.state && Object.hasOwn(entry, "planId")));
  assert.ok(evaluation.resolutions.every((entry) => entry.relationState && Object.hasOwn(entry, "planId")));
  assert.equal(evaluation.resolutions[0].relationState, "observed");
  assert.equal(evaluation.resolutions[0].planId, null);
  assert.equal(evaluation.resolutions[0].verdict, "pass");
  assert.equal(evaluation.resolutions[1].relationState, "planned");
  assert.equal(evaluation.resolutions[1].planId, scenario.planId);
  assert.equal(evaluation.resolutions[1].verdict, "fail");

  const withoutIdentity = evaluateRelations({ snapshot: scenario.snapshot, policy: scenario.policy,
    candidates: [scenario.relations[1]], assertions: assertionsFrom(classification) });
  assert.equal(withoutIdentity.resolutions[0].resolution, "needs-input");
  assert.equal(withoutIdentity.resolutions[0].reason, "plan-identity-required");
  const mismatched = evaluateRelations({ ...scenario,
    candidates: [{ ...scenario.relations[1], planId: "another-plan" }],
    assertions: assertionsFrom(classification), planId: scenario.planId });
  assert.equal(mismatched.resolutions[0].verdict, "fail");
  assert.equal(mismatched.resolutions[0].reason, "plan-identity-mismatch");
});

test("mixed resolutions survive composition and causally duplicate actions are deduplicated", () => {
  const scenario = byId.get("mixed-outcomes");
  const workflow = composedWorkflow({ ...scenario, overlay: undefined });
  assert.deepEqual(workflow.steps.classification.resolutions.map((entry) => entry.resolution),
    ["decided", "decided", "needs-input"]);
  assert.deepEqual(workflow.steps.evaluation.resolutions.map((entry) => entry.resolution),
    ["decided", "needs-input"]);
  const unknownActions = workflow.nextActions.filter((entry) => entry.semanticKey === "classify:unknown");
  assert.equal(unknownActions.length, 1);
});

test("incomplete observation remains epistemic unless an independent decisive failure exists", () => {
  const scenario = byId.get("incomplete-observation");
  const workflow = composedWorkflow({ ...scenario, overlay: undefined });
  assert.equal(workflow.steps.evaluation.resolutions[0].resolution, "indeterminate");
  assert.equal(workflow.steps.evaluation.resolutions[0].verdict, undefined);
  assert.equal(validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay }).resolution,
    "indeterminate");

  const mixed = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy,
    overlay: { baseSnapshotId: scenario.snapshot.id, operations: [{ kind: "add", path: "../escape" }] } });
  assert.equal(mixed.resolution, "decided");
  assert.equal(mixed.verdict, "fail");
  assert.ok(mixed.diagnostics.some((entry) => entry.code === "invalid-mutation"));
});

test("overlay validation binds exact mutations and ignores caller-supplied prospective assertions", () => {
  const scenario = byId.get("clean-control");
  const baseline = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay });
  const lied = clone(scenario.overlay);
  lied.plannedSubjects = [{ id: "lie", path: "vendor/unmapped.js" }];
  lied.plannedRelations = [{ id: "lie", source: "x", target: "y", type: "forbidden" }];
  const ignored = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: lied });
  assert.equal(ignored.verdict, "pass");
  assert.equal(ignored.planId, baseline.planId);
  assert.equal(ignored.prospectiveSnapshotId, baseline.prospectiveSnapshotId);
  assert.equal(Object.hasOwn(ignored, "reevaluation"), false);

  const substituted = clone(scenario.overlay);
  substituted.operations[0].contentDigest = "content:unrelated-substitution";
  const rebound = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: substituted });
  assert.notEqual(rebound.planId, baseline.planId);
  assert.notEqual(rebound.prospectiveSnapshotId, baseline.prospectiveSnapshotId);
});

test("virtual case-fold state updates after add, replace, and delete", () => {
  const snapshot = { id: "case-state", paths: ["src/Old.js"], coverage: { files: "complete", relations: "complete" } };
  const policy = { classificationRules: [{ prefix: "src/", kind: "source" }], allowedRelations: [] };
  const twoAdds = validateOverlay({ snapshot: { ...snapshot, paths: [] }, policy,
    overlay: { baseSnapshotId: "case-state", operations: [
      { kind: "add", path: "src/New.js" }, { kind: "add", path: "src/new.js" }
    ] } });
  assert.equal(twoAdds.verdict, "fail");
  assert.ok(twoAdds.diagnostics.some((entry) => entry.code === "case-collision" && entry.operationIndex === 1));

  const replaceThenReuse = validateOverlay({ snapshot, policy, overlay: { baseSnapshotId: "case-state", operations: [
    { kind: "replace", path: "src/Old.js", newPath: "src/Moved.js" },
    { kind: "add", path: "src/Old.js" }, { kind: "delete", path: "src/Moved.js" }
  ] } });
  assert.equal(replaceThenReuse.verdict, "pass");
  const deleteThenRestore = validateOverlay({ snapshot, policy, overlay: { baseSnapshotId: "case-state", operations: [
    { kind: "delete", path: "src/Old.js" }, { kind: "add", path: "src/Old.js" }
  ] } });
  assert.equal(deleteThenRestore.verdict, "pass");
  const caseRename = byId.get("delete-rename-case-ambiguity");
  assert.equal(validateOverlay({ snapshot: caseRename.snapshot, policy: caseRename.policy, overlay: caseRename.overlay }).verdict,
    "fail");
});

test("invalid overlay and path inputs never return decided without a verdict", () => {
  const scenario = byId.get("clean-control");
  for (const overlay of [42, {}, { baseSnapshotId: scenario.snapshot.id, operations: [{ kind: "add", path: "/absolute" }] }]) {
    const result = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay });
    if (result.resolution === "decided") assert.match(result.verdict, /^(pass|fail)$/);
  }
  assert.equal(validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: undefined }).resolution,
    "needs-input");
});

test("resolution algebra and one-resolution-per-target hold across the fixture corpus", () => {
  for (const scenario of scenarios) {
    const classification = classifySubjects(scenario);
    const evaluation = evaluateRelations({ ...scenario, candidates: scenario.relations,
      assertions: assertionsFrom(classification) });
    assert.equal(classification.resolutions.length, scenario.subjects.length, `${scenario.id}: classifications`);
    assert.equal(evaluation.resolutions.length, scenario.relations.length, `${scenario.id}: relations`);
    for (const entry of [...classification.resolutions, ...evaluation.resolutions]) {
      if (entry.resolution === "decided") assert.match(entry.verdict, /^(pass|fail)$/, entry.targetId);
      else assert.equal(entry.verdict, undefined, entry.targetId);
    }
  }
});

test("mixed overlay causes remain visible and semantic repair actions are deduplicated", () => {
  const scenario = byId.get("mixed-outcomes");
  const result = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay });
  assert.equal(result.verdict, "fail");
  assert.ok(result.diagnostics.some((entry) => entry.code === "classification-unknown"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "endpoint-unclassified"));
  assert.equal(result.actions.filter((entry) => entry.semanticKey === "classify:vendor/odd.js").length, 1);
});

test("behavioral metamorphics prove each public operation owns only its output dimension", () => {
  const scenario = byId.get("clean-control");
  const baseClass = classifySubjects(scenario);
  const changedClass = classifySubjects({ ...scenario, policy: { ...scenario.policy,
    classificationRules: scenario.policy.classificationRules.map((rule) =>
      rule.prefix === "src/domain/" ? { ...rule, kind: "changed-kind" } : rule) } });
  assert.notDeepEqual(assertionsFrom(changedClass), assertionsFrom(baseClass));

  const baseEvaluation = evaluateRelations({ ...scenario, candidates: scenario.relations,
    assertions: assertionsFrom(baseClass), planId: scenario.planId });
  const changedEvaluation = evaluateRelations({ ...scenario, policy: { ...scenario.policy, allowedRelations: [] },
    candidates: scenario.relations, assertions: assertionsFrom(baseClass), planId: scenario.planId });
  assert.equal(baseEvaluation.resolutions[0].verdict, "pass");
  assert.equal(changedEvaluation.resolutions[0].verdict, "fail");
  assert.deepEqual(assertionsFrom(baseClass), assertionsFrom(classifySubjects(scenario)));

  const baseOverlay = validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay });
  const staleOverlay = validateOverlay({ snapshot: { ...scenario.snapshot, id: "different-base" },
    policy: scenario.policy, overlay: scenario.overlay });
  assert.equal(baseOverlay.verdict, "pass");
  assert.equal(staleOverlay.resolution, "stale");
  assert.deepEqual(assertionsFrom(baseClass), assertionsFrom(classifySubjects(scenario)));
  assert.deepEqual(baseEvaluation, evaluateRelations({ ...scenario, candidates: scenario.relations,
    assertions: assertionsFrom(baseClass), planId: scenario.planId }));
});

test("operation identities remain separate through narrow composition", () => {
  assert.deepEqual(operationVersions, {
    classify: "classify-subjects@1", evaluate: "evaluate-relations@1", overlay: "validate-overlay@1"
  });
  const workflow = composedWorkflow(byId.get("clean-control"));
  assert.equal(workflow.steps.classification.operation, operationVersions.classify);
  assert.equal(workflow.steps.evaluation.operation, operationVersions.evaluate);
  assert.equal(workflow.steps.validation.operation, operationVersions.overlay);
});

test("repeated, parallel, and permuted execution has deterministic defined order behavior", async () => {
  const scenario = byId.get("clean-control");
  const run = () => validateOverlay({ snapshot: scenario.snapshot, policy: scenario.policy, overlay: scenario.overlay });
  const serial = Array.from({ length: 20 }, run);
  assert.ok(serial.every((entry) => JSON.stringify(entry) === JSON.stringify(serial[0])));
  const parallel = await Promise.all(Array.from({ length: 20 }, async () => run()));
  assert.ok(parallel.every((entry) => JSON.stringify(entry) === JSON.stringify(serial[0])));

  const snapshot = { id: "permute", paths: [], coverage: { files: "complete", relations: "complete" } };
  const policy = { classificationRules: [{ prefix: "src/", kind: "source" }], allowedRelations: [] };
  const first = validateOverlay({ snapshot, policy, overlay: { baseSnapshotId: "permute", operations: [
    { kind: "add", path: "src/a.js" }, { kind: "add", path: "src/b.js" }
  ] } });
  const second = validateOverlay({ snapshot, policy, overlay: { baseSnapshotId: "permute", operations: [
    { kind: "add", path: "src/b.js" }, { kind: "add", path: "src/a.js" }
  ] } });
  assert.equal(first.verdict, second.verdict);
  assert.notEqual(first.planId, second.planId);
  assert.equal(first.prospectiveSnapshotId, second.prospectiveSnapshotId);
});
