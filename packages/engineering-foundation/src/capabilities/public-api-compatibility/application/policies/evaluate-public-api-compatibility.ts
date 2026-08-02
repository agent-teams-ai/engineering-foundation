import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { semanticVersionBumpBetween } from "../../../../semantic-version.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type {
  PackageReleaseEvidence,
  PublicApiChangeSet,
  PublicApiChangeSetV1,
  PublicApiChangeSetV2,
  PublicApiEntrypointItemReference,
  PublicApiEntrypointSnapshot,
  PublicApiItem,
  PublicApiPackagePolicy,
  PublicApiSnapshot,
  ReleaseBump
} from "../model/public-api.js";
import {
  compareCanonicalReferences,
  publicApiDeclarationEntryPoint,
  publicApiSnapshotEntrypoints
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

interface EntrypointItemChange {
  readonly added: readonly PublicApiItem[];
  readonly changed: readonly string[];
  readonly changedEvidence: readonly {
    readonly before: PublicApiItem | undefined;
    readonly after: PublicApiItem | undefined;
  }[];
  readonly breakingAdded: readonly string[];
  readonly removed: readonly string[];
}

function classifyEntrypointItems(
  releasedItems: readonly PublicApiItem[],
  currentItems: readonly PublicApiItem[]
): EntrypointItemChange {
  const released = new Map(
    releasedItems.map((item) => [item.canonicalReference, item])
  );
  const current = new Map(
    currentItems.map((item) => [item.canonicalReference, item])
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
  const added = [...current.values()]
    .filter((item) => !released.has(item.canonicalReference))
    .toSorted((left, right) =>
      compareCanonicalReferences(left.canonicalReference, right.canonicalReference)
    );
  return Object.freeze({
    added,
    changed,
    changedEvidence: changed.map((canonicalReference) =>
      Object.freeze({
        before: released.get(canonicalReference),
        after: current.get(canonicalReference)
      })
    ),
    breakingAdded: added
      .filter((item) => addedItemIsBreaking(item, released, current))
      .map((item) => item.canonicalReference),
    removed
  });
}

function classifyV1PublicApiChange(
  releasedSnapshot: PublicApiSnapshot,
  currentSnapshot: PublicApiSnapshot,
  fingerprint: ChangeFingerprint
): PublicApiChangeSetV1 {
  if (releasedSnapshot.schemaVersion !== 1 || currentSnapshot.schemaVersion !== 1) {
    throw new Error("Public API schema v1 comparisons require two v1 snapshots.");
  }
  const comparison = classifyEntrypointItems(
    releasedSnapshot.items,
    currentSnapshot.items
  );
  const added = comparison.added.map((item) => item.canonicalReference);
  const breaking =
    comparison.removed.length > 0 ||
    comparison.changed.length > 0 ||
    comparison.breakingAdded.length > 0;
  const changeEvidence = {
    added: comparison.added,
    changed: comparison.changedEvidence,
    removed: comparison.removed.map((canonicalReference) =>
      releasedSnapshot.items.find((item) => item.canonicalReference === canonicalReference)
    )
  };
  return {
    schemaVersion: 1,
    classification: breaking ? "breaking" : added.length > 0 ? "additive" : "none",
    ...(breaking
      ? { fingerprint: `sha256:${fingerprint.sha256(JSON.stringify(changeEvidence))}` }
      : {}),
    added,
    changed: comparison.changed,
    removed: comparison.removed
  };
}

function entrypointIndex(
  snapshot: PublicApiSnapshot
): ReadonlyMap<string, PublicApiEntrypointSnapshot> {
  const output = new Map<string, PublicApiEntrypointSnapshot>();
  for (const entrypoint of publicApiSnapshotEntrypoints(snapshot)) {
    if (output.has(entrypoint.exportPath)) {
      throw new Error(
        `Public API snapshot has duplicate export path: ${entrypoint.exportPath}.`
      );
    }
    output.set(entrypoint.exportPath, entrypoint);
  }
  return output;
}

function entrypointItemReference(
  exportPath: string,
  canonicalReference: string
): PublicApiEntrypointItemReference {
  return Object.freeze({ exportPath, canonicalReference });
}

function releasedItemsForReferences(
  entrypoint: PublicApiEntrypointSnapshot | undefined,
  references: readonly string[]
): readonly PublicApiItem[] {
  return Object.freeze(
    references.map((canonicalReference) => {
      const item = entrypoint?.items.find(
        (candidate) => candidate.canonicalReference === canonicalReference
      );
      if (item === undefined) {
        throw new Error(
          `Released public API item is missing from its entrypoint: ${canonicalReference}.`
        );
      }
      return item;
    })
  );
}

function compareEntrypointReferences(
  left: PublicApiEntrypointItemReference,
  right: PublicApiEntrypointItemReference
): number {
  const pathOrder = compareCanonicalReferences(left.exportPath, right.exportPath);
  return pathOrder === 0
    ? compareCanonicalReferences(left.canonicalReference, right.canonicalReference)
    : pathOrder;
}

interface V2EntrypointEvidence {
  readonly exportPath: string;
  readonly added: readonly PublicApiItem[];
  readonly changed: readonly {
    readonly before: PublicApiItem | undefined;
    readonly after: PublicApiItem | undefined;
  }[];
  readonly removed: readonly PublicApiItem[];
}

interface V2EntrypointChanges {
  readonly added: readonly PublicApiEntrypointItemReference[];
  readonly changed: readonly PublicApiEntrypointItemReference[];
  readonly entrypointEvidence: readonly V2EntrypointEvidence[];
  readonly hasBreakingAddedItem: boolean;
  readonly removed: readonly PublicApiEntrypointItemReference[];
}

function collectV2EntrypointChanges(
  released: ReadonlyMap<string, PublicApiEntrypointSnapshot>,
  current: ReadonlyMap<string, PublicApiEntrypointSnapshot>,
  exportPaths: readonly string[]
): V2EntrypointChanges {
  const added: PublicApiEntrypointItemReference[] = [];
  const changed: PublicApiEntrypointItemReference[] = [];
  const removed: PublicApiEntrypointItemReference[] = [];
  const entrypointEvidence: V2EntrypointEvidence[] = [];
  let hasBreakingAddedItem = false;
  for (const exportPath of exportPaths) {
    const releasedEntrypoint = released.get(exportPath);
    const currentEntrypoint = current.get(exportPath);
    const comparison = classifyEntrypointItems(
      releasedEntrypoint?.items ?? [],
      currentEntrypoint?.items ?? []
    );
    added.push(
      ...comparison.added.map((item) =>
        entrypointItemReference(exportPath, item.canonicalReference)
      )
    );
    changed.push(
      ...comparison.changed.map((item) => entrypointItemReference(exportPath, item))
    );
    removed.push(
      ...comparison.removed.map((item) => entrypointItemReference(exportPath, item))
    );
    hasBreakingAddedItem ||= comparison.breakingAdded.length > 0;
    if (
      comparison.added.length > 0 ||
      comparison.changed.length > 0 ||
      comparison.removed.length > 0 ||
      releasedEntrypoint === undefined ||
      currentEntrypoint === undefined
    ) {
      entrypointEvidence.push(
        Object.freeze({
          exportPath,
          added: comparison.added,
          changed: comparison.changedEvidence,
          removed: releasedItemsForReferences(releasedEntrypoint, comparison.removed)
        })
      );
    }
  }
  return Object.freeze({
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    entrypointEvidence: Object.freeze(entrypointEvidence),
    hasBreakingAddedItem,
    removed: Object.freeze(removed)
  });
}

function classifyV2PublicApiChange(
  releasedSnapshot: PublicApiSnapshot,
  currentSnapshot: PublicApiSnapshot,
  fingerprint: ChangeFingerprint
): PublicApiChangeSetV2 {
  if (releasedSnapshot.schemaVersion !== 2 || currentSnapshot.schemaVersion !== 2) {
    throw new Error("Public API schema v2 comparisons require two v2 snapshots.");
  }
  const released = entrypointIndex(releasedSnapshot);
  const current = entrypointIndex(currentSnapshot);
  const exportPaths = [...new Set([...released.keys(), ...current.keys()])].toSorted(
    compareCanonicalReferences
  );
  const addedEntrypoints = exportPaths.filter(
    (exportPath) => !released.has(exportPath)
  );
  const removedEntrypoints = exportPaths.filter(
    (exportPath) => !current.has(exportPath)
  );
  const changes = collectV2EntrypointChanges(released, current, exportPaths);
  const breaking =
    removedEntrypoints.length > 0 ||
    changes.removed.length > 0 ||
    changes.changed.length > 0 ||
    changes.hasBreakingAddedItem;
  const classification = breaking
    ? "breaking"
    : addedEntrypoints.length > 0 || changes.added.length > 0
      ? "additive"
      : "none";
  const changeEvidence = {
    addedEntrypoints,
    removedEntrypoints,
    entrypoints: changes.entrypointEvidence
  };
  return Object.freeze({
    schemaVersion: 2,
    classification,
    ...(breaking
      ? { fingerprint: `sha256:${fingerprint.sha256(JSON.stringify(changeEvidence))}` }
      : {}),
    addedEntrypoints: Object.freeze(addedEntrypoints),
    removedEntrypoints: Object.freeze(removedEntrypoints),
    added: Object.freeze(changes.added.toSorted(compareEntrypointReferences)),
    changed: Object.freeze(changes.changed.toSorted(compareEntrypointReferences)),
    removed: Object.freeze(changes.removed.toSorted(compareEntrypointReferences))
  });
}

export function classifyPublicApiChange(
  releasedSnapshot: PublicApiSnapshot,
  currentSnapshot: PublicApiSnapshot,
  fingerprint: ChangeFingerprint
): PublicApiChangeSet {
  if (releasedSnapshot.schemaVersion !== currentSnapshot.schemaVersion) {
    throw new Error("Public API snapshots must use the same schema version.");
  }
  return releasedSnapshot.schemaVersion === 1
    ? classifyV1PublicApiChange(releasedSnapshot, currentSnapshot, fingerprint)
    : classifyV2PublicApiChange(releasedSnapshot, currentSnapshot, fingerprint);
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
        path: publicApiDeclarationEntryPoint(input.policy)
      })
    );
  } else if (BUMP_RANK[input.releaseEvidence.declaredBump] < BUMP_RANK[required]) {
    diagnostics.push(
      diagnostic({
        rule: PUBLIC_API_COMPATIBILITY_RULES.insufficientChangeset,
        subject,
        message: `Public API change requires ${required}; Changeset declares ${input.releaseEvidence.declaredBump}.`,
        path: publicApiDeclarationEntryPoint(input.policy)
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
          path: publicApiDeclarationEntryPoint(input.policy),
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
