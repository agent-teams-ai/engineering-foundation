import type {
  DocumentDescriptor,
  DocumentIntent,
  DocumentJsonValue,
  DocumentMetadataObject,
  DocumentReceiptContract
} from "@agent-teams/engineering-foundation/document-authoring";

export const DOCS_PROTOCOL_ID = "agent-teams.docs-protocol" as const;
export const DOCS_PROTOCOL_VERSION = 1 as const;
export const DOCS_ADOPTION_MAX_MANIFEST_BYTES = 1024 * 1024;
export const DOCS_ADOPTION_MAX_ROUTING_BYTES = 64 * 1024;
export const DOCS_ADOPTION_MAX_SKILL_BYTES = 16 * 1024;

export type DocsCommand =
  | "docs.check"
  | "docs.doctor"
  | "docs.find"
  | "docs.info"
  | "docs.new"
  | "docs.recover";

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

export interface DocsCommandEnvelope<Result = unknown> {
  readonly schemaVersion: 1;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly command: DocsCommand;
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}

export interface DocsExecution<Result> {
  readonly envelope: DocsCommandEnvelope<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}

export interface DocsTypeProfile {
  readonly type: string;
  readonly initialStatus: string;
  readonly allowedOwnerIds: readonly string[];
  readonly identity: {
    readonly format: "adr-four-digits" | "open-decision-three-digits" | "qualified";
  };
  readonly heading: { readonly kind: "id-colon-title" | "title" };
  readonly placement:
    | { readonly kind: "collection"; readonly [key: string]: unknown }
    | {
        readonly kind: "explicit";
        readonly requiredSegmentsInOrder: readonly string[];
      }
    | { readonly kind: "qualified-leaf-index"; readonly [key: string]: unknown };
  readonly requiredMetadata: readonly string[];
  readonly reachability:
    | { readonly kind: "manual-fixed-index"; readonly indexPath: string }
    | {
        readonly kind: "manual-colocated-index";
        readonly indexBasename: "README.md";
        readonly pathPrefix: "before-required-segments";
      }
    | { readonly kind: "not-required"; readonly reason: string };
}

export interface DocsProtocolProfile {
  readonly schemaVersion: 1;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly foundationProfile: {
    readonly metadataSidecarPolicy: "foundation-profile-v2-strict-merge";
    readonly path: string;
    readonly schemaVersion: 2;
  };
  readonly agentWorkflow: {
    readonly skillPath: string;
  };
  readonly semanticValidatorIds: readonly string[];
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

export interface DocsFindDocument extends DocumentDescriptor {
  readonly metadata: DocumentMetadataObject;
  readonly related: readonly string[];
  readonly blockedBy: readonly string[];
}

export interface DocsNewRequest {
  readonly apply: boolean;
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly intent: Omit<DocumentIntent, "schemaVersion" | "related" | "additionalMetadata">;
  readonly related?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly codeAnchors?: readonly DocumentJsonValue[];
  readonly additionalMetadata?: Readonly<Record<string, DocumentJsonValue>>;
  readonly signal?: AbortSignal;
}

export interface DocsCodeAnchor {
  readonly enforcement: "advisory" | "required";
  readonly pattern: string;
}

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
        outcome: DocumentReceiptContract["outcome"];
      }>;
      receiptDigest: `sha256:${string}`;
      receiptOutcome: DocumentReceiptContract["outcome"];
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

export interface ReachabilityAction {
  readonly state: "manual-required" | "not-required";
  readonly indexPath?: string;
  readonly markdownLink?: string;
  readonly reason?: string;
}
