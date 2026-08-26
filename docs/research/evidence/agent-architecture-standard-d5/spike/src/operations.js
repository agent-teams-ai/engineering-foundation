import { createHash } from "node:crypto";

const versions = Object.freeze({
  classify: "classify-subjects@1",
  evaluate: "evaluate-relations@1",
  overlay: "validate-overlay@1"
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function stateOf(value) {
  return value.state ?? (value.planned === true ? "planned" : "observed");
}

function context(operation, snapshot, policy, targetId, state, planId) {
  return {
    operation,
    targetId,
    snapshotId: snapshot.id,
    policyDigest: digest(policy),
    state,
    planId: state === "planned" ? (planId ?? null) : null
  };
}

function action(code, targetId, semanticKey = `${code}:${targetId}`) {
  return { code, targetId, semanticKey };
}

function matchRule(path, policy) {
  return policy.classificationRules.find((rule) => path.startsWith(rule.prefix));
}

function classifyPath(subject, policy) {
  if (!subject.path) return undefined;
  const rule = matchRule(subject.path, policy);
  if (!rule) return undefined;
  return { subjectId: subject.id, path: subject.path, kind: rule.kind };
}

export function classifySubjects({ snapshot, policy, subjects, planId }) {
  const policyDigest = digest(policy);
  return {
    operation: versions.classify,
    snapshotId: snapshot.id,
    policyDigest,
    planId: planId ?? null,
    resolutions: subjects.map((subject) => {
      const state = stateOf(subject);
      const effectivePlanId = subject.planId ?? planId;
      const base = context(versions.classify, snapshot, policy, subject.id, state, effectivePlanId);
      if (!['planned', 'observed'].includes(state)) {
        return { ...base, resolution: "decided", verdict: "fail", reason: "invalid-subject-state",
          evidence: [{ code: "invalid-subject-state", state }], actions: [action("fix-subject-state", subject.id)] };
      }
      if (state === "planned" && !effectivePlanId) {
        return { ...base, resolution: "needs-input", reason: "plan-identity-required", missing: ["plan-id"],
          evidence: [{ code: "plan-identity-required" }], actions: [action("provide-plan-identity", subject.id)] };
      }
      if (state === "planned" && subject.planId && planId && subject.planId !== planId) {
        return { ...base, resolution: "decided", verdict: "fail", reason: "plan-identity-mismatch",
          expectedPlanId: planId, evidence: [{ code: "plan-identity-mismatch" }],
          actions: [action("bind-subject-to-plan", subject.id)] };
      }
      const assertion = classifyPath(subject, policy);
      if (!assertion) {
        return { ...base, resolution: "needs-input", reason: "classification-unknown",
          missing: [subject.path ? "vocabulary-rule" : "subject-path"],
          evidence: [{ code: "classification-unknown", subjectId: subject.id }],
          actions: [action("map-subject", subject.id, `classify:${subject.id}`)] };
      }
      return { ...base, resolution: "decided", verdict: "pass",
        assertion: { ...assertion, state, planId: state === "planned" ? effectivePlanId : null },
        evidence: [{ code: "prefix-rule", prefix: matchRule(subject.path, policy).prefix }], actions: [] };
    })
  };
}

function assertionMap(assertions) {
  return new Map(assertions.map((entry) => [entry.subjectId, entry]));
}

function evaluateCandidate(candidate, assertions, policy, effectivePlanId) {
  if (candidate.assertion === "not-observed") return { allowed: true };
  const source = assertions.get(candidate.source);
  const target = assertions.get(candidate.target);
  if (!source || !target) return { missing: [!source && candidate.source, !target && candidate.target].filter(Boolean) };
  const state = stateOf(candidate);
  if (state === "observed" && (source.state === "planned" || target.state === "planned")) {
    return { invalid: "observed-relation-uses-planned-subject" };
  }
  if (state === "planned" && [source, target].some((entry) => entry.state === "planned" && entry.planId !== effectivePlanId)) {
    return { invalid: "endpoint-plan-identity-mismatch" };
  }
  return {
    allowed: policy.allowedRelations.some((rule) =>
      rule.from === source.kind && rule.to === target.kind && rule.type === candidate.type),
    source,
    target
  };
}

export function evaluateRelations({ snapshot, policy, candidates, assertions = [], planId }) {
  const mapped = assertionMap(assertions);
  return {
    operation: versions.evaluate,
    snapshotId: snapshot.id,
    policyDigest: digest(policy),
    planId: planId ?? null,
    resolutions: candidates.map((candidate) => {
      const state = stateOf(candidate);
      const effectivePlanId = candidate.planId ?? planId;
      const base = { ...context(versions.evaluate, snapshot, policy, candidate.id, state, effectivePlanId), relationState: state };
      if (!['planned', 'observed'].includes(state)) {
        return { ...base, resolution: "decided", verdict: "fail", reason: "invalid-relation-state",
          evidence: [{ code: "invalid-relation-state", state }], actions: [action("fix-relation-state", candidate.id)] };
      }
      if (state === "planned" && !effectivePlanId) {
        return { ...base, resolution: "needs-input", reason: "plan-identity-required", missing: ["plan-id"],
          evidence: [{ code: "plan-identity-required" }], actions: [action("provide-plan-identity", candidate.id)] };
      }
      if (state === "planned" && candidate.planId && planId && candidate.planId !== planId) {
        return { ...base, resolution: "decided", verdict: "fail", reason: "plan-identity-mismatch",
          expectedPlanId: planId, evidence: [{ code: "plan-identity-mismatch" }],
          actions: [action("bind-relation-to-plan", candidate.id)] };
      }
      if (candidate.assertion === "not-observed" && snapshot.coverage.relations !== "complete") {
        return { ...base, resolution: "indeterminate", reason: "observation-incomplete",
          evidence: [{ code: "relation-coverage", state: snapshot.coverage.relations }],
          actions: [action("complete-relation-observation", candidate.id)] };
      }
      const evaluated = evaluateCandidate(candidate, mapped, policy, effectivePlanId);
      if (evaluated.missing) {
        return { ...base, resolution: "needs-input", reason: "endpoint-unclassified",
          missing: evaluated.missing.map((id) => `${id}-classification`), evidence: [{ code: "endpoint-unclassified" }],
          actions: evaluated.missing.map((id) => action("map-subject", id, `classify:${id}`)) };
      }
      if (evaluated.invalid) {
        return { ...base, resolution: "decided", verdict: "fail", reason: evaluated.invalid,
          evidence: [{ code: evaluated.invalid }], actions: [action("repair-relation-identity", candidate.id)] };
      }
      const verdict = evaluated.allowed ? "pass" : "fail";
      return { ...base, resolution: "decided", verdict,
        evidence: [{ code: evaluated.allowed ? "relation-allowed" : "relation-denied",
          from: evaluated.source?.kind, to: evaluated.target?.kind, relationState: state }],
        actions: evaluated.allowed ? [] : [action("reverse-or-remove-relation", candidate.id)] };
    })
  };
}

function validPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 256 &&
    !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

function fold(path) {
  return path.toLowerCase();
}

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collisionIndex(paths) {
  const index = new Map();
  for (const path of paths) {
    const key = fold(path);
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(path);
  }
  return index;
}

function removePath(paths, collisions, path) {
  paths.delete(path);
  const entries = collisions.get(fold(path));
  entries?.delete(path);
  if (entries?.size === 0) collisions.delete(fold(path));
}

function addPath(paths, collisions, path) {
  paths.add(path);
  if (!collisions.has(fold(path))) collisions.set(fold(path), new Set());
  collisions.get(fold(path)).add(path);
}

function diagnostic(code, index, path, actionCode) {
  return { code, operationIndex: index, ...(path ? { path } : {}),
    actions: actionCode ? [action(actionCode, path ?? String(index))] : [] };
}

function validateShape(overlay) {
  const diagnostics = [];
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    return [diagnostic("overlay-required", -1, undefined, "provide-overlay")];
  }
  if (typeof overlay.baseSnapshotId !== "string" || !Array.isArray(overlay.operations)) {
    diagnostics.push(diagnostic("invalid-overlay-shape", -1, undefined, "fix-overlay-shape"));
  }
  return diagnostics;
}

function planIdentity(overlay) {
  return digest({ baseSnapshotId: overlay.baseSnapshotId, operations: overlay.operations,
    relationChanges: overlay.relationChanges ?? [] });
}

function applyOperations(snapshot, overlay) {
  const paths = new Set(snapshot.paths);
  const entries = new Map(snapshot.paths.map((path) => [path,
    snapshot.contents?.[path] ?? { baseSnapshotId: snapshot.id, path }]));
  const collisions = collisionIndex(snapshot.paths);
  const diagnostics = [];
  const affected = new Set();
  const deletedByFold = new Map();
  for (const [index, operation] of overlay.operations.entries()) {
    if (!operation || !["add", "replace", "delete"].includes(operation.kind) || !validPath(operation.path) ||
        (operation.newPath !== undefined && !validPath(operation.newPath))) {
      diagnostics.push(diagnostic("invalid-mutation", index, operation?.path, "fix-mutation"));
      continue;
    }
    const destination = operation.newPath ?? operation.path;
    const sourceExists = paths.has(operation.path);
    if (operation.kind === "add") {
      if (sourceExists) diagnostics.push(diagnostic("add-path-exists", index, operation.path, "choose-new-path"));
      const variants = collisions.get(fold(operation.path));
      if (variants && !variants.has(operation.path)) diagnostics.push(diagnostic("case-collision", index, operation.path, "use-explicit-portable-paths"));
      const deletedVariant = deletedByFold.get(fold(operation.path));
      if (deletedVariant && deletedVariant !== operation.path) {
        diagnostics.push(diagnostic("case-collision", index, operation.path, "use-explicit-portable-paths"));
      }
      if (!sourceExists && (!variants || variants.size === 0) && (!deletedVariant || deletedVariant === operation.path)) {
        addPath(paths, collisions, operation.path);
        entries.set(operation.path, operation.contentDigest ?? null);
        deletedByFold.delete(fold(operation.path));
        affected.add(operation.path);
      }
      continue;
    }
    if (!sourceExists) {
      diagnostics.push(diagnostic("precondition-failed", index, operation.path, "refresh-overlay-preconditions"));
      continue;
    }
    if (operation.kind === "delete") {
      removePath(paths, collisions, operation.path);
      entries.delete(operation.path);
      deletedByFold.set(fold(operation.path), operation.path);
      affected.delete(operation.path);
      continue;
    }
    const replacedContent = entries.get(operation.path);
    removePath(paths, collisions, operation.path);
    entries.delete(operation.path);
    const variants = collisions.get(fold(destination));
    if ((variants && !variants.has(destination)) || (fold(destination) === fold(operation.path) && destination !== operation.path)) {
      diagnostics.push(diagnostic("case-collision", index, destination, "use-explicit-portable-paths"));
      addPath(paths, collisions, operation.path);
      entries.set(operation.path, replacedContent);
      continue;
    }
    addPath(paths, collisions, destination);
    entries.set(destination, operation.contentDigest ?? replacedContent);
    affected.delete(operation.path);
    affected.add(destination);
  }
  return { paths, entries, diagnostics, affected };
}

function privateProspectivePolicy(snapshot, policy, prospectivePaths, affected, relationChanges, planId) {
  const diagnostics = [];
  const assertions = new Map();
  const relations = new Map((snapshot.relations ?? []).map((relation) => [relation.id, relation]));
  const neededPaths = new Set(affected);
  for (const relation of relationChanges) {
    if (relation?.sourcePath) neededPaths.add(relation.sourcePath);
    if (relation?.targetPath) neededPaths.add(relation.targetPath);
  }
  for (const path of [...neededPaths].sort()) {
    if (!validPath(path)) {
      diagnostics.push({ code: "invalid-relation-path", path });
      continue;
    }
    const classified = classifyPath({ id: path, path }, policy);
    if (!classified) diagnostics.push({ code: "classification-unknown", path });
    else assertions.set(path, { ...classified, state: "planned", planId });
  }
  for (const relation of relationChanges) {
    if (!relation || !["add", "delete"].includes(relation.kind) || typeof relation.id !== "string" ||
        typeof relation.type !== "string" || !validPath(relation.sourcePath) || !validPath(relation.targetPath)) {
      diagnostics.push({ code: "invalid-relation-mutation", relationId: relation?.id ?? null });
      continue;
    }
    if (relation.kind === "delete") {
      if (!relations.has(relation.id)) diagnostics.push({ code: "relation-precondition-failed", relationId: relation.id });
      else relations.delete(relation.id);
      continue;
    }
    if (relations.has(relation.id)) {
      diagnostics.push({ code: "relation-add-exists", relationId: relation.id });
      continue;
    }
    const missingProspectivePaths = [relation.sourcePath, relation.targetPath].filter((path) => !prospectivePaths.has(path));
    if (missingProspectivePaths.length) {
      diagnostics.push({ code: "relation-endpoint-missing", relationId: relation.id, missingPaths: missingProspectivePaths });
      continue;
    }
    relations.set(relation.id, { id: relation.id, sourcePath: relation.sourcePath,
      targetPath: relation.targetPath, type: relation.type, state: "planned", planId });
    const source = assertions.get(relation.sourcePath);
    const target = assertions.get(relation.targetPath);
    if (!source || !target) {
      diagnostics.push({ code: "endpoint-unclassified", relationId: relation.id,
        missingPaths: [!source && relation.sourcePath, !target && relation.targetPath].filter(Boolean) });
      continue;
    }
    const allowed = policy.allowedRelations.some((rule) =>
      rule.from === source.kind && rule.to === target.kind && rule.type === relation.type);
    if (!allowed) diagnostics.push({ code: "relation-denied", relationId: relation.id,
      from: source.kind, to: target.kind, relationState: "planned", planId });
  }
  return { diagnostics, relations };
}

function actionsFromDiagnostics(diagnostics) {
  const actions = diagnostics.flatMap((entry) => entry.actions ??
    (entry.code === "classification-unknown" ? [action("map-subject", entry.path, `classify:${entry.path}`)] :
      entry.code === "endpoint-unclassified" ? entry.missingPaths.map((path) => action("map-subject", path, `classify:${path}`)) :
      entry.code === "relation-denied" ? [action("reverse-or-remove-relation", entry.relationId)] : []));
  return [...new Map(actions.map((entry) => [entry.semanticKey, entry])).values()];
}

export function validateOverlay({ snapshot, policy, overlay }) {
  const shapeProblems = validateShape(overlay);
  if (shapeProblems.length) {
    const missing = shapeProblems[0].code === "overlay-required";
    return { operation: versions.overlay, overlayDigest: overlay ? digest(overlay) : null,
      planId: null, resolution: missing ? "needs-input" : "decided", ...(missing ? {} : { verdict: "fail" }),
      reason: shapeProblems[0].code, diagnostics: shapeProblems, evidence: shapeProblems,
      actions: actionsFromDiagnostics(shapeProblems) };
  }
  const overlayDigest = digest(overlay);
  const planId = planIdentity(overlay);
  if (overlay.baseSnapshotId !== snapshot.id) {
    return { operation: versions.overlay, overlayDigest, planId, resolution: "stale", reason: "stale-base",
      expected: overlay.baseSnapshotId, observed: snapshot.id, diagnostics: [{ code: "stale-base" }],
      evidence: [{ code: "stale-base" }], actions: [action("refresh-overlay-base", planId)] };
  }
  const applied = applyOperations(snapshot, overlay);
  const relationChanges = Array.isArray(overlay.relationChanges) ? overlay.relationChanges : [];
  if (overlay.relationChanges !== undefined && !Array.isArray(overlay.relationChanges)) {
    applied.diagnostics.push({ code: "invalid-relation-mutations" });
  }
  const prospectivePolicy = privateProspectivePolicy(snapshot, policy, applied.paths, applied.affected, relationChanges, planId);
  const policyDiagnostics = prospectivePolicy.diagnostics;
  const diagnostics = [...applied.diagnostics, ...policyDiagnostics]
    .sort((a, b) => lexical(JSON.stringify(canonical(a)), JSON.stringify(canonical(b))));
  const decisiveFailure = diagnostics.length > 0;
  const incomplete = snapshot.coverage.files !== "complete" || snapshot.coverage.relations !== "complete";
  const prospectiveSnapshotId = digest({ entries: [...applied.entries].sort(([left], [right]) => lexical(left, right)),
    relations: [...prospectivePolicy.relations.values()].map(canonical)
      .sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b))) });
  if (!decisiveFailure && incomplete) {
    return { operation: versions.overlay, overlayDigest, planId, resolution: "indeterminate",
      reason: "observation-incomplete", prospectiveSnapshotId, diagnostics: [{ code: "observation-incomplete" }],
      evidence: [{ code: "observation-incomplete" }], actions: [action("complete-observation", planId)] };
  }
  return { operation: versions.overlay, overlayDigest, planId, resolution: "decided",
    verdict: decisiveFailure ? "fail" : "pass",
    reason: decisiveFailure ? (policyDiagnostics.length ? "prospective-policy-failure" : diagnostics[0].code) : "exact-overlay-valid",
    prospectiveSnapshotId, diagnostics,
    evidence: [{ code: "atomic-virtual-application", operationCount: overlay.operations.length,
      affectedPaths: [...applied.affected].sort(), reevaluatedRelations: relationChanges.length }],
    actions: actionsFromDiagnostics(diagnostics) };
}

export const operationVersions = versions;
