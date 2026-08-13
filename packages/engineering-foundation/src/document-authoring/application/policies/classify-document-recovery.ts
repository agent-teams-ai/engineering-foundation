/**
 * A closed, side-effect-free recovery decision for the document writer.
 *
 * `exact` describes byte equality. Identity relationships are separate so that
 * byte equality can never accidentally grant ownership or recovery authority.
 */
export type DocumentRecoveryTemporaryObservation =
  | { readonly state: "absent" }
  | { readonly state: "exact"; readonly identity: "nonzero" }
  | { readonly state: "replaced"; readonly identity: "nonzero" }
  | { readonly state: "zero-identity" }
  | { readonly state: "unverifiable" };

export type DocumentRecoveryDestinationObservation =
  | { readonly state: "absent" }
  | { readonly state: "conflict" }
  | {
      readonly state: "exact";
      readonly identity:
        | "unbound"
        | "bound-temporary"
        | "bound-publication"
        | "different"
        | "zero-identity";
    }
  | { readonly state: "unverifiable" };

export type DocumentRecoveryJournalObservation =
  | {
      readonly version: "none";
      readonly fileIdentity: "none";
    }
  | {
      /** Released v1 evidence is read-only and never grants recovery authority. */
      readonly version: "v1-legacy";
      readonly fileIdentity: "nonzero" | "zero-identity" | "unverifiable";
    }
  | {
      readonly version: "v2";
      readonly fileIdentity: "nonzero" | "zero-identity" | "unverifiable";
      readonly lifecycle: "PREPARED";
      readonly boundIdentity: "none";
    }
  | {
      readonly version: "v2";
      readonly fileIdentity: "nonzero" | "zero-identity" | "unverifiable";
      readonly lifecycle: "PUBLISHING";
      readonly boundIdentity: "temporary" | "zero-identity" | "unverifiable";
    }
  | {
      readonly version: "v2";
      readonly fileIdentity: "nonzero" | "zero-identity" | "unverifiable";
      readonly lifecycle: "PUBLISHED";
      readonly boundIdentity: "publication" | "zero-identity" | "unverifiable";
    };

export interface DocumentRecoveryObservation {
  readonly journal: DocumentRecoveryJournalObservation;
  readonly temporary: DocumentRecoveryTemporaryObservation;
  readonly destination: DocumentRecoveryDestinationObservation;
}

export type DocumentRecoveryManualReason =
  | "destination-conflict"
  | "identity-drift"
  | "inconsistent-lifecycle"
  | "legacy-journal"
  | "orphan-temporary"
  | "publication-missing"
  | "temporary-missing"
  | "unverifiable-identity"
  | "zero-identity";

export type DocumentRecoveryDecision =
  | { readonly action: "resume-prepare" }
  | { readonly action: "resume-publish" }
  | { readonly action: "complete-publication" }
  | { readonly action: "finalize-checks" }
  | {
      readonly action: "already-applied";
      readonly cleanup: "none" | "owned-temporary";
    }
  | {
      readonly action: "manual";
      readonly reason: DocumentRecoveryManualReason;
    };

function manual(reason: DocumentRecoveryManualReason): DocumentRecoveryDecision {
  return { action: "manual", reason };
}

function containsZeroIdentity(
  observation: DocumentRecoveryObservation
): boolean {
  if (observation.journal.fileIdentity === "zero-identity") {
    return true;
  }
  if (observation.temporary.state === "zero-identity") {
    return true;
  }
  if (
    observation.destination.state === "exact" &&
    observation.destination.identity === "zero-identity"
  ) {
    return true;
  }
  return observation.journal.version === "v2" &&
    observation.journal.boundIdentity === "zero-identity";
}

function containsUnverifiableIdentity(
  observation: DocumentRecoveryObservation
): boolean {
  if (observation.journal.fileIdentity === "unverifiable") {
    return true;
  }
  if (observation.temporary.state === "unverifiable") {
    return true;
  }
  if (observation.destination.state === "unverifiable") {
    return true;
  }
  return observation.journal.version === "v2" &&
    observation.journal.boundIdentity === "unverifiable";
}

function classifyWithoutJournal(
  observation: DocumentRecoveryObservation
): DocumentRecoveryDecision {
  if (observation.temporary.state !== "absent") {
    return manual("orphan-temporary");
  }
  switch (observation.destination.state) {
    case "absent":
      return { action: "resume-prepare" };
    case "conflict":
      return manual("destination-conflict");
    case "unverifiable":
      return manual("unverifiable-identity");
    case "exact":
      return observation.destination.identity === "unbound"
        ? { action: "already-applied", cleanup: "none" }
        : manual("inconsistent-lifecycle");
  }
}

function classifyPrepared(
  observation: DocumentRecoveryObservation
): DocumentRecoveryDecision {
  if (observation.temporary.state !== "absent") {
    return manual("orphan-temporary");
  }
  switch (observation.destination.state) {
    case "absent":
      return { action: "resume-prepare" };
    case "conflict":
      return manual("destination-conflict");
    case "unverifiable":
      return manual("unverifiable-identity");
    case "exact":
      return manual("inconsistent-lifecycle");
  }
}

function classifyPublishing(
  observation: DocumentRecoveryObservation
): DocumentRecoveryDecision {
  switch (observation.destination.state) {
    case "conflict":
      return manual("destination-conflict");
    case "unverifiable":
      return manual("unverifiable-identity");
    case "absent":
      if (observation.temporary.state === "absent") {
        return manual("temporary-missing");
      }
      return observation.temporary.state === "exact"
        ? { action: "resume-publish" }
        : manual("identity-drift");
    case "exact":
      if (observation.destination.identity === "bound-temporary") {
        return { action: "complete-publication" };
      }
      if (
        observation.destination.identity === "different" &&
        observation.temporary.state === "exact"
      ) {
        return { action: "already-applied", cleanup: "owned-temporary" };
      }
      return manual("identity-drift");
  }
}

function classifyPublished(
  observation: DocumentRecoveryObservation
): DocumentRecoveryDecision {
  if (observation.temporary.state !== "absent") {
    return manual("orphan-temporary");
  }
  switch (observation.destination.state) {
    case "absent":
      return manual("publication-missing");
    case "conflict":
      return manual("destination-conflict");
    case "unverifiable":
      return manual("unverifiable-identity");
    case "exact":
      return observation.destination.identity === "bound-publication"
        ? { action: "finalize-checks" }
        : manual("identity-drift");
  }
}

/**
 * Classifies a fully observed recovery snapshot. This function never mutates
 * evidence and deliberately has no catch-all optimistic branch.
 */
export function classifyDocumentRecovery(
  observation: DocumentRecoveryObservation
): DocumentRecoveryDecision {
  if (containsZeroIdentity(observation)) {
    return manual("zero-identity");
  }
  if (containsUnverifiableIdentity(observation)) {
    return manual("unverifiable-identity");
  }
  switch (observation.journal.version) {
    case "none":
      return classifyWithoutJournal(observation);
    case "v1-legacy":
      return manual("legacy-journal");
    case "v2":
      switch (observation.journal.lifecycle) {
        case "PREPARED":
          return classifyPrepared(observation);
        case "PUBLISHING":
          return classifyPublishing(observation);
        case "PUBLISHED":
          return classifyPublished(observation);
      }
  }
}
