import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";

/**
 * One journal slot is a canonical pathname whose content transitions through
 * a hard-linked candidate, a private quarantine directory for the previous
 * content, and terminal evidence directories. Owner packages describe their
 * slot with a profile; the mechanics never depend on the journal vocabulary.
 */
export type JournalSlotMutation = "create" | "remove" | "replace";

export type JournalSlotEvidence = "candidate" | "previous";

export type JournalSlotSyncRole = "destination" | "source" | "state-parent";

export type JournalSlotSyncStage =
  | "candidate"
  | "final"
  | "publication"
  | "transition";

export type JournalSlotFaultPoint =
  | { readonly mutation: JournalSlotMutation; readonly phase: "after-candidate-synced" }
  | {
      readonly mutation: "remove" | "replace";
      readonly path: string;
      readonly phase: "before-quarantine-directory";
    }
  | {
      readonly mutation: "remove" | "replace";
      readonly path: string;
      readonly phase: "before-shared-quarantine";
    }
  | { readonly mutation: "remove" | "replace"; readonly phase: "after-shared-quarantine-synced" }
  | { readonly mutation: "create" | "replace"; readonly phase: "before-canonical-link" }
  | { readonly mutation: "create" | "replace"; readonly phase: "after-canonical-linked" }
  | { readonly mutation: "create" | "replace"; readonly phase: "after-canonical-synced" }
  | {
      readonly evidence: JournalSlotEvidence;
      readonly mutation: JournalSlotMutation;
      readonly path: string;
      readonly phase: "before-retirement-directory";
    }
  | {
      readonly evidence: JournalSlotEvidence;
      readonly mutation: JournalSlotMutation;
      readonly path: string;
      readonly phase: "before-private-retirement";
    }
  | {
      readonly evidence: JournalSlotEvidence;
      readonly mutation: JournalSlotMutation;
      readonly path: string;
      readonly phase: "before-private-retirement-rename";
    }
  | {
      readonly evidence: JournalSlotEvidence;
      readonly mutation: JournalSlotMutation;
      readonly path: string;
      readonly phase: "before-logical-retirement";
    }
  | { readonly mutation: JournalSlotMutation; readonly phase: "before-final-directory-sync" }
  | { readonly mutation: JournalSlotMutation; readonly phase: "after-final-directory-sync" }
  | {
      readonly mutation: JournalSlotMutation;
      readonly path: string;
      readonly phase: "before-directory-sync";
      readonly role: JournalSlotSyncRole;
      readonly stage: JournalSlotSyncStage;
    }
  | { readonly phase: "before-reconciliation-directory-sync" };

export type JournalSlotFaultInjector = (
  point: JournalSlotFaultPoint
) => Promise<void> | void;

export interface JournalSlotAuthority {
  readonly authorityDigest: `sha256:${string}`;
  readonly identity: PortablePathIdentity;
}

export interface StoredJournalSlot<TJournal> {
  readonly authority: JournalSlotAuthority;
  readonly journal: TJournal;
}

export type JournalSlotSubject =
  | "candidate"
  | "canonical"
  | "evidence"
  | "quarantine"
  | "replacement"
  | "retired-evidence";

export type JournalSlotFailure =
  | "candidate-exists"
  | "candidate-unavailable"
  | "canonical-recreated"
  | "changed"
  | "must-be-stabilized"
  | "not-regular-file"
  | "publication-conflict"
  | "quarantine-unavailable"
  | "slot-occupied"
  | "state-directory-missing"
  | "too-many-entries"
  | "transition-residue";

export interface JournalSlotFailureContext {
  readonly cause?: unknown;
  readonly evidence?: JournalSlotEvidence;
  readonly mutation?: JournalSlotMutation | "read" | "stabilize";
  readonly subject?: JournalSlotSubject;
}

/** Owners translate closed failure classes into their released diagnostics. */
export type JournalSlotFailureFactory = (
  failure: JournalSlotFailure,
  context: JournalSlotFailureContext
) => Error;

export interface JournalSlotCodec<TJournal> {
  /** Returns validated canonical bytes or throws the owner's contract error. */
  readonly serialize: (journal: TJournal) => Promise<Buffer>;
  /** Parses stable canonical bytes or throws the owner's contract error. */
  readonly parse: (bytes: Buffer) => Promise<TJournal>;
}

export type JournalSlotResidueMatcher =
  | { readonly exact: string }
  | { readonly prefix: string };

export interface JournalSlotNaming {
  readonly candidatePath: string;
  readonly quarantineDirectoryName: (previous: JournalSlotAuthority) => string;
  readonly residues: readonly JournalSlotResidueMatcher[];
  readonly retiredDirectoryName: () => string;
  readonly terminalRootName: string;
}

export interface JournalSlotProfile<TJournal> {
  readonly canonicalPath: string;
  readonly codec: JournalSlotCodec<TJournal>;
  readonly failure: JournalSlotFailureFactory;
  readonly faultInjector?: JournalSlotFaultInjector;
  readonly maximumBytes: number;
  readonly naming: JournalSlotNaming;
  /** Directory syncs whose `before-directory-sync` fault point is observable. */
  readonly observableSyncStages: readonly JournalSlotSyncStage[];
  /**
   * How the canonical slot is inspected before a mutation and after a
   * removal: `authority` compares identity and bytes only, `parsed` also
   * requires the content to satisfy the owner's codec and reports codec and
   * non-regular-file diagnostics first.
   */
  readonly canonicalInspection: "authority" | "parsed";
  /** Whether an unfinished mutation blocks reads until reconciliation. */
  readonly reconciliation: "residue-only" | "sticky-pending";
  readonly syncDirectory: (path: string) => Promise<void>;
}

export type JournalSlotObservation<TJournal> =
  | {
      readonly outcome: "stable";
      readonly stored?: StoredJournalSlot<TJournal>;
    }
  | {
      readonly outcome: "committed" | "not-applied";
      readonly stored?: StoredJournalSlot<TJournal>;
    }
  | {
      readonly canonical?: StoredJournalSlot<TJournal>;
      readonly outcome: "recovery-required";
      readonly residueNames: readonly string[];
    };

export type PendingJournalSlotMutation =
  | {
      intendedAuthority?: JournalSlotAuthority;
      readonly kind: "create";
    }
  | {
      intendedAuthority?: JournalSlotAuthority;
      readonly kind: "replace";
      readonly prior: JournalSlotAuthority;
    }
  | {
      readonly kind: "remove";
      readonly prior: JournalSlotAuthority;
    };

export function sameJournalSlotAuthority(
  left: JournalSlotAuthority,
  right: JournalSlotAuthority
): boolean {
  return left.authorityDigest === right.authorityDigest &&
    left.identity.birthtimeNs === right.identity.birthtimeNs &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino;
}

export function classifyCleanJournalSlotMutation(
  pending: PendingJournalSlotMutation,
  canonical: JournalSlotAuthority | undefined
): "committed" | "not-applied" | "recovery-required" {
  if (pending.kind === "remove") {
    if (canonical === undefined) {
      return "committed";
    }
    return sameJournalSlotAuthority(canonical, pending.prior)
      ? "not-applied"
      : "recovery-required";
  }
  if (
    pending.intendedAuthority !== undefined &&
    canonical !== undefined &&
    sameJournalSlotAuthority(canonical, pending.intendedAuthority)
  ) {
    return "committed";
  }
  if (pending.kind === "create") {
    return canonical === undefined ? "not-applied" : "recovery-required";
  }
  return canonical !== undefined &&
    sameJournalSlotAuthority(canonical, pending.prior)
    ? "not-applied"
    : "recovery-required";
}
