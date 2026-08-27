import type {
  DocumentDescriptor,
  DocumentIntent,
  DocumentJsonValue,
  DocumentMetadataObject,
  DocumentPlanV2,
  DocumentReceiptContract,
  DocumentTransactionInspectionV2,
  DocumentationCatalogSnapshotV2
} from "@agent-teams/engineering-foundation/document-authoring";

export const DOCS_PROTOCOL_ID = "agent-teams.docs-protocol" as const;
export const DOCS_PROTOCOL_VERSION = 1 as const;

export type DocsCommand =
  | "docs.check"
  | "docs.doctor"
  | "docs.find"
  | "docs.info"
  | "docs.new"
  | "docs.qualify"
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
  readonly schemaVersion: 1 | 2;
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
  readonly schemaVersion: 1 | 2;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly foundationProfile: {
    readonly metadataSidecarPolicy: "foundation-profile-v2-strict-merge" | "foundation-profile-v3-strict-merge";
    readonly path: string;
    readonly schemaVersion: 2 | 3;
  };
  readonly agentWorkflow: {
    readonly skillPath: string;
  };
  readonly semanticValidatorIds: readonly string[];
}

export interface FoundationDocsDescription {
  readonly authority: {
    readonly metadataSchema: { readonly digest: string; readonly path: string; readonly size: number };
    readonly metadataSidecar?: { readonly digest: string; readonly path: string; readonly size: number };
    readonly ownerCatalog: { readonly digest: string; readonly path: string; readonly size: number };
    readonly profile: { readonly digest: string; readonly path: string; readonly size: number };
    readonly templates: readonly {
      readonly evidence: { readonly digest: string; readonly path: string; readonly size: number };
      readonly type: string;
    }[];
  };
  readonly projectId: string;
  readonly catalog: {
    readonly collections: readonly unknown[];
    readonly excludedPrefixes: readonly string[];
  };
  readonly profileSchemaVersion: 2 | 3;
  readonly semanticDigest: string;
  readonly metadataSchemaPath: string;
  readonly metadataSidecar: { readonly kind: "none" } | { readonly kind: "path-metadata-map"; readonly path: string };
  readonly ownerIds: readonly string[];
  readonly types: readonly DocsTypeProfile[];
  readonly authorityPaths: readonly string[];
}

export interface DocsAdoptionInspector {
  inspect(input: {
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

export interface DocsCompiledDocumentV1 {
  readonly schemaVersion: 1;
  readonly document: {
    readonly content: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType: "text/markdown; charset=utf-8";
    readonly size: number;
  };
  readonly frontmatter: string;
  readonly metadata: Readonly<Record<string, DocumentJsonValue>>;
  readonly relations: {
    readonly blockedBy: readonly string[];
    readonly related: readonly string[];
  };
  readonly anchors: readonly DocsCodeAnchor[];
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
      compiled: DocsCompiledDocumentV1;
      documentPath: string;
      kind: "new";
      planDigest: `sha256:${string}`;
      reachability: ReachabilityAction;
      reservation: "none";
      writeState: "preview";
    }>
  | Readonly<{
      compiled: DocsCompiledDocumentV1;
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

export interface FoundationDocsPort {
  inspectEnvironment(input: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly installedFoundationVersion: string;
    readonly installedFoundationBuildIdentity: string;
    readonly filesystem: {
      readonly basis: "platform-contract";
      readonly strictDirectoryDurability: "platform-supported" | "platform-unsupported";
    };
  }>;
  describe(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<FoundationDocsDescription>;
  buildCatalog(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentationCatalogSnapshotV2>;
  find(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly query: DocsFindQuery;
    readonly signal?: AbortSignal;
  }): Promise<readonly DocsFindDocument[]>;
  inspect(consumerRoot: string): Promise<DocumentTransactionInspectionV2>;
  plan(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly intent: DocumentIntent;
    readonly parentPolicy: "create-missing-real-directories";
    readonly signal?: AbortSignal;
  }): Promise<DocumentPlanV2>;
  apply(input: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlanV2;
    readonly signal?: AbortSignal;
  }): Promise<DocumentReceiptContract>;
  recover(input: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentReceiptContract>;
}

export interface DocsProfileReader {
  read(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }): Promise<DocsProtocolProfile>;
}
