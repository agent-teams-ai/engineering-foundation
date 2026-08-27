import type {
  DocumentIntent,
  DocumentPlanV2,
  DocumentReceiptContract,
  DocumentTransactionInspectionV2,
  DocumentationCatalogSnapshotV2
} from "@agent-teams/engineering-foundation/document-authoring";

import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsCodeAnchor,
  type DocsCommandOutcome,
  type DocsDiagnostic,
  type DocsFindDocument,
  type DocsFindQuery,
  type DocsNewResult,
  type DocsTypeProfile
} from "./model.js";

export type DocsCommandV2 =
  | "docs.check"
  | "docs.doctor"
  | "docs.find"
  | "docs.info"
  | "docs.new"
  | "docs.qualify"
  | "docs.recover";

export type DocsJsonValueV2 =
  | boolean
  | null
  | number
  | string
  | readonly DocsJsonValueV2[]
  | { readonly [key: string]: DocsJsonValueV2 };

export interface DocsCommandEnvelopeV2<Result = unknown> {
  readonly schemaVersion: 2;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly command: DocsCommandV2;
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}

export interface DocsExecutionV2<Result> {
  readonly envelope: DocsCommandEnvelopeV2<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}

export interface DocsProtocolProfileV2 {
  readonly schemaVersion: 2;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly foundationProfile: {
    readonly metadataSidecarPolicy: "foundation-profile-v3-strict-merge";
    readonly path: string;
    readonly schemaVersion: 3;
  };
  readonly agentWorkflow: { readonly skillPath: string };
  readonly semanticValidatorIds: readonly string[];
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
  readonly metadata: Readonly<Record<string, DocsJsonValueV2>>;
  readonly relations: {
    readonly blockedBy: readonly string[];
    readonly related: readonly string[];
  };
  readonly anchors: readonly DocsCodeAnchor[];
}

export type DocsNewResultV2 =
  | Exclude<DocsNewResult, Extract<DocsNewResult, { readonly writeState: "preview" }> | Extract<DocsNewResult, { readonly receipt: unknown }>>
  | Readonly<Extract<DocsNewResult, { readonly writeState: "preview" }> & { readonly compiled: DocsCompiledDocumentV1 }>
  | Readonly<Extract<DocsNewResult, { readonly receipt: unknown }> & { readonly compiled: DocsCompiledDocumentV1 }>;

export interface FoundationDocsDescriptionV2 {
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

export interface FoundationDocsPortV2 {
  inspectEnvironment(input: { readonly consumerRoot: string; readonly signal?: AbortSignal }): Promise<{
    readonly installedFoundationVersion: string;
    readonly installedFoundationBuildIdentity: string;
    readonly filesystem: {
      readonly basis: "platform-contract";
      readonly strictDirectoryDurability: "platform-supported" | "platform-unsupported";
    };
  }>;
  describe(input: { readonly consumerRoot: string; readonly profilePath: string; readonly profileSchemaVersion: 2 | 3; readonly signal?: AbortSignal }): Promise<FoundationDocsDescriptionV2>;
  buildCatalog(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }): Promise<DocumentationCatalogSnapshotV2>;
  find(input: { readonly consumerRoot: string; readonly profilePath: string; readonly query: DocsFindQuery; readonly signal?: AbortSignal }): Promise<readonly DocsFindDocument[]>;
  inspect(consumerRoot: string): Promise<DocumentTransactionInspectionV2>;
  plan(input: { readonly consumerRoot: string; readonly profilePath: string; readonly intent: DocumentIntent; readonly parentPolicy: "create-missing-real-directories"; readonly signal?: AbortSignal }): Promise<DocumentPlanV2>;
  apply(input: { readonly consumerRoot: string; readonly plan: DocumentPlanV2; readonly signal?: AbortSignal }): Promise<DocumentReceiptContract>;
  recover(input: { readonly consumerRoot: string; readonly signal?: AbortSignal }): Promise<DocumentReceiptContract>;
}

export interface DocsProfileReaderV2 {
  read(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }): Promise<import("./model.js").DocsProtocolProfile | DocsProtocolProfileV2>;
}
