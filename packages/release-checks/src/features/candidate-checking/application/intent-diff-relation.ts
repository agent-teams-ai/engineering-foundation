import type {
  ChangeKind,
  Diagnostic,
  FileLeaf,
  LeafShape,
  PlannedConsumption,
  PlannedRelease,
  ReleaseCandidateInput,
  ReleaseIntent,
} from "./model.js";
import { reject, same, type CandidateFacts } from "./relations.js";

function shape(leaf: FileLeaf | null): LeafShape | null {
  return leaf === null ? null : ({ type: leaf.type, mode: leaf.mode } as LeafShape);
}
function presence(kind: ChangeKind, before: unknown, after: unknown): boolean {
  return kind === "added"
    ? before === null && after !== null
    : kind === "deleted"
      ? before !== null && after === null
      : before !== null && after !== null;
}
function checkReleaseLinks(
  release: PlannedRelease,
  facts: CandidateFacts,
  diagnostics: Diagnostic[],
): void {
  for (const intentId of release.intentIds) {
    const at = { packageName: release.packageName, path: release.manifestPath, intentId };
    const intent = facts.intents.get(intentId);
    if (intent === undefined) {
      reject(diagnostics, "intent.unknown", at, "Plan links an unknown intent.");
    } else if (
      intent.participation !== "pending" ||
      !intent.requests.some((request) => request.packageName === release.packageName) ||
      facts.packages.get(release.packageName)?.versioning !== "versioned"
    ) {
      reject(
        diagnostics,
        "intent.coverage",
        at,
        "A direct plan link must reciprocate an eligible pending request.",
      );
    }
  }
}
function checkPlan(facts: CandidateFacts, diagnostics: Diagnostic[]): void {
  for (const release of facts.releases.values()) {
    const at = { packageName: release.packageName, path: release.manifestPath };
    const p = facts.packages.get(release.packageName);
    if (release.type === "none" && release.oldVersion !== release.newVersion) {
      reject(
        diagnostics,
        "plan.version-mismatch",
        at,
        "An unchanged plan record cannot request a version change.",
      );
    }
    if (p === undefined) {
      reject(
        diagnostics,
        "package.unknown",
        at,
        "Plan references a package outside the classified inventory.",
      );
    } else if (
      p.manifestPath !== release.manifestPath ||
      (p.versioning !== "versioned" && release.oldVersion !== release.newVersion)
    ) {
      reject(
        diagnostics,
        "intent.coverage",
        at,
        "Plan package path or version eligibility differs from accepted facts.",
      );
    }
    checkReleaseLinks(release, facts, diagnostics);
  }
}
function eligibleRequests(
  intent: ReleaseIntent,
  facts: CandidateFacts,
  diagnostics: Diagnostic[],
): number {
  const at = { intentId: intent.id, path: intent.path };
  let eligible = 0;
  for (const request of intent.requests) {
    const p = facts.packages.get(request.packageName);
    if (p === undefined) {
      reject(
        diagnostics,
        "package.unknown",
        { ...at, packageName: request.packageName },
        "Intent requests an unknown package.",
      );
    }
    if (intent.participation !== "pending" || p?.versioning !== "versioned") {
      continue;
    }
    eligible += 1;
    const release = facts.releases.get(request.packageName);
    if (
      release === undefined ||
      release.oldVersion === release.newVersion ||
      !release.intentIds.includes(intent.id)
    ) {
      reject(
        diagnostics,
        "intent.coverage",
        { ...at, packageName: request.packageName },
        "Eligible pending request lacks its exact direct planned release.",
      );
    }
  }
  return eligible;
}
function checkParticipation(
  facts: CandidateFacts,
  hasRelease: boolean,
  diagnostics: Diagnostic[],
): void {
  for (const intent of facts.intents.values()) {
    const at = { intentId: intent.id, path: intent.path };
    const eligible = eligibleRequests(intent, facts, diagnostics);
    const consumption = facts.consumptions.get(intent.id);
    if (eligible > 0 && (eligible !== intent.requests.length || consumption === undefined)) {
      reject(
        diagnostics,
        "intent.coverage",
        at,
        "Pending releasable intent must be wholly eligible and have a qualified consumption.",
      );
    }
    if (
      consumption !== undefined &&
      (intent.participation !== "pending" ||
        !hasRelease ||
        (intent.requests.length > 0 && eligible !== intent.requests.length))
    ) {
      reject(
        diagnostics,
        "intent.consumption",
        at,
        "Retained/ineligible intents and no-release candidates cannot be consumed.",
      );
    }
  }
}
function checkConsumptionEffect(
  consumption: PlannedConsumption,
  intent: ReleaseIntent,
  facts: CandidateFacts,
  diagnostics: Diagnostic[],
): void {
  const at = { intentId: intent.id };
  const diff = facts.diff.get(intent.path);
  if (consumption.effect.kind === "remove") {
    if (
      diff?.kind !== "deleted" ||
      diff.before?.digest !== intent.digest ||
      diff.before.type !== "file" ||
      diff.before.mode !== "100644" ||
      diff.after !== null
    ) {
      reject(
        diagnostics,
        "intent.consumption",
        { ...at, path: intent.path },
        "Removed consumption must match the original ordinary intent file deletion.",
      );
    }
  } else {
    const path = consumption.effect.evidencePath;
    const evidence = facts.diff.get(path);
    if (
      diff !== undefined ||
      facts.manifests.has(path) ||
      facts.intentPaths.has(path) ||
      evidence === undefined ||
      evidence.kind === "deleted" ||
      evidence.after?.type !== "file" ||
      evidence.after.mode !== "100644"
    ) {
      reject(
        diagnostics,
        "intent.consumption",
        { ...at, path },
        "Recorded consumption requires changed Host metadata and an unchanged retained intent file.",
      );
    }
  }
}
function checkConsumptions(facts: CandidateFacts, diagnostics: Diagnostic[]): void {
  for (const consumption of facts.consumptions.values()) {
    const intent = facts.intents.get(consumption.intentId);
    const at = { intentId: consumption.intentId };
    if (intent === undefined) {
      reject(
        diagnostics,
        "intent.unknown",
        at,
        "Expected consumption references an unknown intent.",
      );
      continue;
    }
    const observed = facts.observedConsumptions.get(intent.id);
    if (
      observed === undefined ||
      observed.digest !== intent.digest ||
      !same(consumption.effect, observed.effect)
    ) {
      reject(
        diagnostics,
        "intent.consumption",
        { ...at, path: intent.path },
        "Observed consumption identity, original digest or effect differs from the frozen expectation.",
      );
    }
    checkConsumptionEffect(consumption, intent, facts, diagnostics);
  }
  for (const observed of facts.observedConsumptions.values()) {
    if (!facts.intents.has(observed.intentId)) {
      reject(
        diagnostics,
        "intent.unknown",
        { intentId: observed.intentId },
        "Observed consumption references an unknown intent.",
      );
    } else if (!facts.consumptions.has(observed.intentId)) {
      reject(
        diagnostics,
        "intent.consumption",
        { intentId: observed.intentId },
        "Observed intent consumption was not planned.",
      );
    }
  }
  for (const intent of facts.intents.values()) {
    if (
      facts.diff.has(intent.path) &&
      facts.consumptions.get(intent.id)?.effect.kind !== "remove"
    ) {
      reject(
        diagnostics,
        "intent.consumption",
        { intentId: intent.id, path: intent.path },
        "Intent content must remain unchanged unless its exact removal is planned.",
      );
    }
  }
}

export function checkPlanAndIntents(
  input: ReleaseCandidateInput,
  facts: CandidateFacts,
  diagnostics: Diagnostic[],
): void {
  checkPlan(facts, diagnostics);
  checkParticipation(
    facts,
    input.expected.plan.releases.some((release) => release.oldVersion !== release.newVersion),
    diagnostics,
  );
  checkConsumptions(facts, diagnostics);
}

export function checkDiff(
  input: ReleaseCandidateInput,
  facts: CandidateFacts,
  diagnostics: Diagnostic[],
): void {
  for (const permit of facts.permissions.values()) {
    if (!presence(permit.kind, permit.before, permit.after)) {
      reject(
        diagnostics,
        "diff.inconsistent",
        { path: permit.path },
        "Permitted change kind and before/after presence are inconsistent.",
      );
    }
  }
  const hasRelease = input.expected.plan.releases.some(
    (release) => release.oldVersion !== release.newVersion,
  );
  for (const change of facts.diff.values()) {
    const at = { path: change.path };
    const permit = facts.permissions.get(change.path);
    if (
      permit === undefined ||
      permit.kind !== change.kind ||
      permit.classification !== change.classification ||
      !same(permit.before, shape(change.before)) ||
      !same(permit.after, shape(change.after))
    ) {
      reject(
        diagnostics,
        "diff.unexpected",
        at,
        "Changed path, classification, kind or file type/mode lacks an exact permission.",
      );
    } else if (!hasRelease) {
      reject(
        diagnostics,
        "diff.unexpected",
        at,
        "A no-release candidate must not mutate its source tree.",
      );
    }
    if (
      !presence(change.kind, change.before, change.after) ||
      (change.kind === "modified" && same(change.before, change.after))
    ) {
      reject(
        diagnostics,
        "diff.inconsistent",
        at,
        "Observed change kind and exact before/after leaf identities are inconsistent.",
      );
    }
  }
}
