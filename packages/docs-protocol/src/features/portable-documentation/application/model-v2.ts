import type { AuthoringCatalog, AuthoringIntent, AuthoringPlan, AuthoringReceipt, AuthoringTransaction } from "./authoring-observation.js";
import type { NormalizedDocsProtocolProfile } from "../domain/documentation-model.js";
export type { DocsBlockerPolicy, DocsProtocolProfileV3, DocsProtocolProfileV4, NormalizedDocsProtocolProfile } from "../domain/documentation-model.js";

import {
  type DocsCodeAnchor,
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
  | "docs.recover";

import type { DocumentJsonValue as DocsJsonValueV2 } from "../domain/metadata.js";
export type { DocumentJsonValue as DocsJsonValueV2 } from "../domain/metadata.js";

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
  | Readonly<Record<string, never> & { readonly kind?: never; readonly writeState?: never }>
  | Exclude<DocsNewResult, Extract<DocsNewResult, { readonly writeState: "preview" }> | Extract<DocsNewResult, { readonly receipt: unknown }>>
  | Readonly<Extract<DocsNewResult, { readonly writeState: "preview" }> & { readonly compiled: DocsCompiledDocumentV1 }>
  | Readonly<Extract<DocsNewResult, { readonly receipt: unknown }> & { readonly compiled: DocsCompiledDocumentV1 }>;

export interface DocumentAuthoringDescriptionV2 {
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
  readonly profileSchemaVersion: 3;
  readonly semanticDigest: string;
  readonly metadataSchemaPath: string;
  readonly metadataSidecar: { readonly kind: "none" } | { readonly kind: "path-metadata-map"; readonly path: string };
  readonly ownerIds: readonly string[];
  readonly types: readonly DocsTypeProfile[];
  readonly authorityPaths: readonly string[];
}

export interface DocumentAuthoringPortV2 {
  inspectEnvironment(input: { readonly consumerRoot: string; readonly signal?: AbortSignal }): Promise<{
    readonly installedFoundationVersion: string;
    readonly installedFoundationBuildIdentity: string;
    readonly filesystem: {
      readonly basis: "platform-contract";
      readonly strictDirectoryDurability: "platform-supported" | "platform-unsupported";
    };
  }>;
  describe(input: { readonly consumerRoot: string; readonly profilePath: string; readonly profileSchemaVersion: 3; readonly signal?: AbortSignal }): Promise<DocumentAuthoringDescriptionV2>;
  buildCatalog(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }): Promise<AuthoringCatalog>;
  find(input: { readonly consumerRoot: string; readonly profilePath: string; readonly query: DocsFindQuery; readonly signal?: AbortSignal }): Promise<readonly DocsFindDocument[]>;
  inspect(consumerRoot: string): Promise<AuthoringTransaction>;
  plan(input: { readonly consumerRoot: string; readonly profilePath: string; readonly intent: AuthoringIntent; readonly parentPolicy: "create-missing-real-directories"; readonly signal?: AbortSignal }): Promise<AuthoringPlan>;
  apply(input: { readonly consumerRoot: string; readonly plan: AuthoringPlan; readonly signal?: AbortSignal }): Promise<AuthoringReceipt>;
  recover(input: { readonly consumerRoot: string; readonly signal?: AbortSignal }): Promise<AuthoringReceipt>;
}

export interface DocsProfileReaderV2 {
  read(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }): Promise<NormalizedDocsProtocolProfile>;
}
