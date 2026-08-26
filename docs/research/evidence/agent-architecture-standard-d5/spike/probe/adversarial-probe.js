import { classifySubjects, evaluateRelations, validateOverlay } from "../src/operations.js";

const failures = [];
const check = (condition, name) => { if (!condition) failures.push(name); };
const snapshot = { id: "probe-base", paths: ["src/existing.js"],
  coverage: { files: "incomplete", relations: "incomplete" } };
const policy = { classificationRules: [{ prefix: "src/", kind: "source" }], allowedRelations: [] };

const exact = { baseSnapshotId: snapshot.id,
  operations: [{ kind: "add", path: "src/new.js", contentDigest: "sha256:first" }] };
const first = validateOverlay({ snapshot: { ...snapshot, coverage: { files: "complete", relations: "complete" } }, policy, overlay: exact });
const substitution = structuredClone(exact);
substitution.operations[0].contentDigest = "sha256:second";
const second = validateOverlay({ snapshot: { ...snapshot, coverage: { files: "complete", relations: "complete" } }, policy, overlay: substitution });
check(first.planId !== second.planId && first.prospectiveSnapshotId !== second.prospectiveSnapshotId,
  "unrelated mutation substitution was not identity-bound");

const collision = validateOverlay({ snapshot: { ...snapshot, paths: [], coverage: { files: "complete", relations: "complete" } }, policy,
  overlay: { baseSnapshotId: snapshot.id, operations: [
    { kind: "add", path: "src/New.js" }, { kind: "add", path: "src/new.js" }
  ] } });
check(collision.resolution === "decided" && collision.verdict === "fail" &&
  collision.diagnostics.some((entry) => entry.code === "case-collision"), "case collision was not rejected");

const mixed = validateOverlay({ snapshot, policy,
  overlay: { baseSnapshotId: snapshot.id, operations: [{ kind: "add", path: "../escape" }] } });
check(mixed.resolution === "decided" && mixed.verdict === "fail", "decisive failure lost to incomplete observation");

const classification = classifySubjects({ snapshot, policy, planId: "probe-plan",
  subjects: [{ id: "planned", path: "src/new.js", state: "planned" }] });
const assertion = classification.resolutions[0].assertion;
const missingPlan = evaluateRelations({ snapshot, policy, assertions: [assertion],
  candidates: [{ id: "planned-edge", source: "planned", target: "planned", type: "imports", state: "planned" }] });
check(missingPlan.resolutions[0].resolution === "needs-input", "missing plan identity did not affect evaluation");

if (failures.length) {
  process.stderr.write(`${JSON.stringify({ status: "fail", failures }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ status: "pass", checks: 4 }, null, 2)}\n`);
}
