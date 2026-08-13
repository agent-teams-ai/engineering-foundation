import type {
  ScaffoldJournalAuthority,
  StoredScaffoldJournal
} from "./node-scaffold-journal-evidence.js";

export type PendingScaffoldJournalMutation =
  | {
      intendedAuthority?: ScaffoldJournalAuthority;
      readonly kind: "create";
    }
  | {
      intendedAuthority?: ScaffoldJournalAuthority;
      readonly kind: "replace";
      readonly prior: StoredScaffoldJournal;
    }
  | {
      readonly kind: "remove";
      readonly prior: StoredScaffoldJournal;
    };

export function sameScaffoldJournalAuthority(
  left: ScaffoldJournalAuthority,
  right: ScaffoldJournalAuthority
): boolean {
  return left.authorityDigest === right.authorityDigest &&
    left.identity.birthtimeNs === right.identity.birthtimeNs &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino;
}

export function classifyCleanScaffoldJournalMutation(
  pending: PendingScaffoldJournalMutation,
  canonical: StoredScaffoldJournal | undefined
): "committed" | "not-applied" | "recovery-required" {
  if (pending.kind === "remove") {
    if (canonical === undefined) {
      return "committed";
    }
    return sameScaffoldJournalAuthority(
      canonical.authority,
      pending.prior.authority
    )
      ? "not-applied"
      : "recovery-required";
  }
  if (
    pending.intendedAuthority !== undefined &&
    canonical !== undefined &&
    sameScaffoldJournalAuthority(
      canonical.authority,
      pending.intendedAuthority
    )
  ) {
    return "committed";
  }
  if (pending.kind === "create") {
    return canonical === undefined ? "not-applied" : "recovery-required";
  }
  return canonical !== undefined &&
    sameScaffoldJournalAuthority(canonical.authority, pending.prior.authority)
    ? "not-applied"
    : "recovery-required";
}
