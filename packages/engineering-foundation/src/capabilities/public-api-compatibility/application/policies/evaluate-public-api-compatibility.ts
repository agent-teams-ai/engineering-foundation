import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { semanticVersionBumpBetween } from "../../../../semantic-version.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { compareCanonicalReferences } from "../model/public-api.js";
import type {
  PackageReleaseEvidence,
  PublicApiChangeSet,
  PublicApiItem,
  PublicApiPackagePolicy,
  PublicApiSnapshot,
  ReleaseBump
} from "../model/public-api.js";
import {
  PUBLIC_API_COMPATIBILITY_RULES,
  type PublicApiCompatibilityRuleMetadata
} from "../rules.js";

const BUMP_RANK: Readonly<Record<ReleaseBump, number>> = {
  patch: 0,
  minor: 1,
  major: 2
};

function diagnostic(input: {
  readonly rule: PublicApiCompatibilityRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function itemChanged(released: PublicApiItem, current: PublicApiItem): boolean {
  return (
    released.kind !== current.kind ||
    released.parentKind !== current.parentKind ||
    released.parentReference !== current.parentReference ||
    released.signature !== current.signature
  );
}

function addedItemIsBreaking(
  item: PublicApiItem,
  released: ReadonlyMap<string, PublicApiItem>,
  current: ReadonlyMap<string, PublicApiItem>
): boolean {
  if (item.parentKind === "EntryPoint") {
    return false;
  }
  let parentReference = item.parentReference;
  const visited = new Set<string>();
  while (parentReference !== undefined && !visited.has(parentReference)) {
    visited.add(parentReference);
    if (released.has(parentReference)) {
      return true;
    }
    const parent = current.get(parentReference);
    if (parent === undefined || parent.parentKind === "EntryPoint") {
      return false;
    }
    parentReference = parent.parentReference;
  }
  return true;
}

export function classifyPublicApiChange(
  releasedSnapshot: PublicApiSnapshot,
  currentSnapshot: PublicApiSnapshot,
  fingerprint: ChangeFingerprint
): PublicApiChangeSet {
  const released = new Map(
    releasedSnapshot.items.map((item) => [item.canonicalReference, item])
  );
  const current = new Map(
    currentSnapshot.items.map((item) => [item.canonicalReference, item])
  );
  const removed = [...released.keys()]
    .filter((key) => !current.has(key))
    .toSorted(compareCanonicalReferences);
  const changed = [...released.entries()]
    .filter(([key, item]) => {
      const currentItem = current.get(key);
      return currentItem !== undefined && itemChanged(item, currentItem);
    })
    .map(([key]) => key)
    .toSorted(compareCanonicalReferences);
  const addedItems = [...current.values()]
    .filter((item) => !released.has(item.canonicalReference))
    .toSorted((left, right) =>
      compareCanonicalReferences(left.canonicalReference, right.canonicalReference)
    );
  const added = addedItems.map((item) => item.canonicalReference);
  const breakingAdded = addedItems
    .filter((item) => addedItemIsBreaking(item, released, current))
    .map((item) => item.canonicalReference);
  const breaking = removed.length > 0 || changed.length > 0 || breakingAdded.length > 0;
  const changeEvidence = {
    added: added.map((reference) => current.get(reference)),
    changed: changed.map((reference) => ({
      before: released.get(reference),
      after: current.get(reference)
    })),
    removed: removed.map((reference) => released.get(reference))
  };
  return {
    classification: breaking ? "breaking" : added.length > 0 ? "additive" : "none",
    ...(breaking
      ? { fingerprint: `sha256:${fingerprint.sha256(JSON.stringify(changeEvidence))}` }
      : {}),
    added,
    changed,
    removed
  };
}

function requiredBump(change: PublicApiChangeSet, packageVersion: string): ReleaseBump {
  if (change.classification === "breaking") {
    return packageVersion.startsWith("0.") ? "minor" : "major";
  }
  return "minor";
}

export function evaluatePublicApiCompatibility(input: {
  readonly policy: PublicApiPackagePolicy;
  readonly released: PublicApiSnapshot;
  readonly current: PublicApiSnapshot;
  readonly change: PublicApiChangeSet;
  readonly releaseEvidence: PackageReleaseEvidence;
  readonly acceptedDecision: boolean | undefined;
}): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const subject = input.policy.packageName;
  if (input.released.extractorVersion !== input.current.extractorVersion) {
    diagnostics.push(
      diagnostic({
        rule: PUBLIC_API_COMPATIBILITY_RULES.baselineToolMismatch,
        subject,
        message: `Released baseline uses API Extractor ${input.released.extractorVersion}; current adapter uses ${input.current.extractorVersion}.`,
        path: input.policy.releasedBaselinePath
      })
    );
    return diagnostics;
  }
  if (
    semanticVersionBumpBetween(
      input.releaseEvidence.packageVersion,
      input.released.packageVersion
    ) !== undefined
  ) {
    diagnostics.push(
      diagnostic({
        rule: PUBLIC_API_COMPATIBILITY_RULES.baselineVersionMismatch,
        subject,
        message: `Package version ${input.releaseEvidence.packageVersion} is older than released baseline ${input.released.packageVersion}.`,
        path: input.policy.manifestPath
      })
    );
    return diagnostics;
  }
  if (
    input.change.classification === "none" &&
    input.released.packageVersion !== input.releaseEvidence.packageVersion
  ) {
    diagnostics.push(
      diagnostic({
        rule: PUBLIC_API_COMPATIBILITY_RULES.baselineVersionMismatch,
        subject,
        message: `Released baseline version ${input.released.packageVersion} does not match package version ${input.releaseEvidence.packageVersion}.`,
        path: input.policy.releasedBaselinePath
      })
    );
    return diagnostics;
  }
  if (input.change.classification === "none") {
    return diagnostics;
  }
  const required = requiredBump(input.change, input.released.packageVersion);
  if (input.releaseEvidence.declaredBump === undefined) {
    diagnostics.push(
      diagnostic({
        rule: PUBLIC_API_COMPATIBILITY_RULES.missingChangeset,
        subject,
        message: `Public API change has no Changeset for ${subject}.`,
        path: input.policy.declarationEntryPoint
      })
    );
  } else if (BUMP_RANK[input.releaseEvidence.declaredBump] < BUMP_RANK[required]) {
    diagnostics.push(
      diagnostic({
        rule: PUBLIC_API_COMPATIBILITY_RULES.insufficientChangeset,
        subject,
        message: `Public API change requires ${required}; Changeset declares ${input.releaseEvidence.declaredBump}.`,
        path: input.policy.declarationEntryPoint
      })
    );
  }
  if (input.change.classification === "breaking") {
    const approval = input.policy.approvedBreakingChanges.find(
      (candidate) => candidate.fingerprint === input.change.fingerprint
    );
    if (approval === undefined) {
      diagnostics.push(
        diagnostic({
          rule: PUBLIC_API_COMPATIBILITY_RULES.breakingChangeNotApproved,
          subject,
          message: "Breaking public API change does not have an approved fingerprint.",
          path: input.policy.declarationEntryPoint,
          evidence: [
            { kind: "change-fingerprint", value: input.change.fingerprint ?? "missing" }
          ]
        })
      );
    } else if (input.acceptedDecision !== true) {
      diagnostics.push(
        diagnostic({
          rule: PUBLIC_API_COMPATIBILITY_RULES.decisionNotAccepted,
          subject,
          message: `Breaking change references a decision that is not accepted: ${approval.decisionPath}.`,
          path: approval.decisionPath,
          evidence: [{ kind: "change-fingerprint", value: approval.fingerprint }]
        })
      );
    }
  }
  return diagnostics;
}
