import type { AuthorityScaffoldPlan } from "../application/model/scaffold-compilation.js";
import type { RepositoryPath, Sha256Digest } from "../application/model/scaffold-values.js";

type ScaffoldOperationOutcome =
  | "already-satisfied"
  | "applied"
  | "conflict"
  | "not-applied"
  | "recovered";

export type AuthorityScaffoldOperationOutcome =
  | ScaffoldOperationOutcome
  | "unobserved";

export interface AuthorityScaffoldOperationReceipt {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly outcome: AuthorityScaffoldOperationOutcome;
  readonly resultDigest?: Sha256Digest;
}

type ScaffoldReceiptOutcome =
  | "already-applied"
  | "applied"
  | "failed-recovered"
  | "recovery-required"
  | "rejected";

export type AuthorityScaffoldReceiptOutcome =
  | ScaffoldReceiptOutcome
  | "authority-stale";

type AuthorityScaffoldJournalOperationState =
  | "pending"
  | "publishing"
  | "published"
  | "preexisting";

export interface AuthorityScaffoldJournalOperation {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly state: AuthorityScaffoldJournalOperationState;
}

export interface AuthorityScaffoldJournal {
  readonly schemaVersion: 1;
  readonly state: "PREPARED";
  readonly plan: AuthorityScaffoldPlan;
  readonly operations: readonly AuthorityScaffoldJournalOperation[];
}
