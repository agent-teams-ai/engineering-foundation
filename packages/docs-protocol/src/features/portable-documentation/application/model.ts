import type { DocumentJsonValue } from "../domain/metadata.js";
import type { ReachabilityAction } from "../domain/documentation-model.js";
export { DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION, DOCS_ADOPTION_MAX_ROUTING_BYTES, DOCS_ADOPTION_MAX_SKILL_BYTES } from "../domain/documentation-model.js";
export type { DocsCodeAnchor, DocsTypeProfile, ReachabilityAction } from "../domain/documentation-model.js";

export type DocsCommandOutcome =
  | "authority-stale"
  | "cancelled"
  | "conflict"
  | "execution-failure"
  | "invalid-input"
  | "recovery-required"
  | "success"
  | "violation";

export interface DocsDiagnostic {
  readonly message: string;
  readonly phase: "apply" | "authority" | "input" | "planning" | "query" | "recovery";
  readonly ruleId: string;
  readonly severity: "error" | "info" | "warning";
  readonly subject: string;
}

export interface DocsAdoptionInspector {
  inspect(input: {
    readonly policy: "portable-v1";
    readonly authorityPaths: readonly string[];
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly skillPath: string;
  }): Promise<readonly DocsDiagnostic[]>;
}

export interface DocsFindQuery {
  readonly text?: string;
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly owner?: string;
  readonly related?: string;
  readonly blockedBy?: string;
}

export interface DocsFindDocument {
  readonly id: string;
  readonly owner: string;
  readonly repositoryPath: string;
  readonly source: "frontmatter-readme" | "markdown-tree";
  readonly status: string;
  readonly summary: string;
  readonly title: string;
  readonly type: string;
  readonly metadata: Readonly<Record<string, DocumentJsonValue>>;
  readonly related: readonly string[];
  readonly blockedBy: readonly string[];
}

export interface DocsNewRequest {
  readonly apply: boolean;
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly intent: {
    readonly type: string;
    readonly id: string;
    readonly title: string;
    readonly owner: string;
    readonly summary: string;
    readonly slug?: string;
    readonly destination?: string;
  };
  readonly related?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly codeAnchors?: readonly DocumentJsonValue[];
  readonly additionalMetadata?: Readonly<Record<string, DocumentJsonValue>>;
  /** Binds Apply to an exact previously reviewed Document Plan. Omit for explicit direct Apply. */
  readonly expectedPlanDigest?: string;
  readonly signal?: AbortSignal;
}

export type DocsReceiptOutcome =
  | "applied" | "already-applied" | "authority-stale" | "rejected"
  | "recovery-required" | "manual-recovery-required" | "failed-before-publication" | "cancelled";

export type DocsNewResult =
  | Readonly<{
      kind: "new";
      reservation: "none";
      writeState: "blocked";
      transaction: Readonly<
        | { state: "idle" }
        | { state: "recoverable"; transactionKind: "document"; recovery: Readonly<{ commandId: "docs.recover"; args: Readonly<{ exactFoundationBuildIdentity: string; exactFoundationVersion: string }> }> }
        | { state: "manual-recovery-required"; transactionKind?: "corrupt" | "document" | "local-mode" | "scaffold" | "transition-residue" | "unknown" | "version-mismatch"; reason: string; recovery?: { readonly commandId: "detach" | "docs-recover" | "scaffold-recover"; readonly args: Readonly<Record<string, string>> } }
      >;
    }>
  | Readonly<{
      kind: "new";
      reason: "adoption-invalid" | "authority-stale";
      reservation: "none";
      writeState: "blocked";
    }>
  | Readonly<{
      documentPath: string;
      kind: "new";
      planDigest: `sha256:${string}`;
      reachability: ReachabilityAction;
      reservation: "none";
      writeState: "preview";
    }>
  | Readonly<{
      documentPath: string;
      kind: "new";
      planDigest: `sha256:${string}`;
      reachability?: ReachabilityAction;
      receipt: Readonly<{
        commit: Readonly<{
          publication: "none" | "preexisting-exact" | "published" | "unknown";
          recoverability: "not-required" | "preserved-for-recovery";
          state: "committed" | "manual-recovery-required" | "not-published" | "recovery-required";
        }>;
        directoryMaterialization?: {
          readonly observedCreatedDirectories: readonly string[];
          readonly plannedDirectories: readonly string[];
          readonly state: "none-created" | "created-and-retained" | "preserved-unknown";
        };
        outcome: DocsReceiptOutcome;
      }>;
      receiptDigest: `sha256:${string}`;
      receiptOutcome: DocsReceiptOutcome;
      reservation: "none";
      writeState: "already-applied" | "applied" | "published-recovery-required" | "unchanged" | "unknown";
    }>;

export interface CodeAnchorMatcher {
  matchedPatterns(input: {
    readonly consumerRoot: string;
    readonly patterns: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<readonly string[]>;
}
