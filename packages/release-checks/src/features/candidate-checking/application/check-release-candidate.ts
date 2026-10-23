import type { CheckReport, Diagnostic, PackageChange } from "./model.js";
import { parseInput } from "./parse-input.js";
import { candidateFacts, ordinal, reject, same } from "./relations.js";
import { checkManifests } from "./manifest-relation.js";
import { checkDiff, checkPlanAndIntents } from "./intent-diff-relation.js";

function report(diagnostics: Diagnostic[], changes: PackageChange[]): CheckReport {
  const packageChanges = Object.freeze(
    changes.toSorted(
      (a, b) => ordinal(a.packageName, b.packageName) || ordinal(a.manifestPath, b.manifestPath),
    ),
  );
  if (diagnostics.length === 0) {
    return Object.freeze({
      schemaVersion: 1,
      outcome: "passed",
      diagnostics: Object.freeze([] as const),
      packageChanges,
    });
  }
  const ordered = diagnostics.toSorted(
    (a, b) =>
      ordinal(a.packageName ?? "", b.packageName ?? "") ||
      ordinal(a.path ?? "", b.path ?? "") ||
      ordinal(a.code, b.code) ||
      ordinal(a.intentId ?? "", b.intentId ?? "") ||
      ordinal(a.message, b.message),
  );
  return Object.freeze({
    schemaVersion: 1,
    outcome: "rejected",
    diagnostics: Object.freeze(ordered),
    packageChanges,
  });
}

/** Pure relation only. The Host authenticates source, complete observations, engine and every content authority. */
export function checkReleaseCandidate(input: unknown): CheckReport {
  const parsed = parseInput(input);
  if ("error" in parsed) {
    return report([Object.freeze({ code: "input.invalid", message: parsed.error })], []);
  }
  const diagnostics: Diagnostic[] = [];
  const facts = candidateFacts(parsed.value, diagnostics);
  if (diagnostics.length > 0) {
    return report(diagnostics, []);
  }
  if (!same(parsed.value.expected.binding, parsed.value.observed.binding)) {
    reject(
      diagnostics,
      "binding.mismatch",
      {},
      "Observed source, inventory/policy, engine/config, intents or plan binding differs from accepted inputs.",
    );
  }
  checkPlanAndIntents(parsed.value, facts, diagnostics);
  const changes = checkManifests(facts, diagnostics);
  checkDiff(parsed.value, facts, diagnostics);
  return report(diagnostics, changes);
}
