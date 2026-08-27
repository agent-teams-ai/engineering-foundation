import type { DocumentJsonValue } from "@agent-teams/engineering-foundation/document-authoring";

export interface DocsProtocolQualificationScenarioV2 {
  readonly id: string;
  readonly type: string;
  readonly intent: {
    readonly id: string;
    readonly title: string;
    readonly owner: string;
    readonly summary: string;
    readonly slug?: string;
    readonly destination?: string;
    readonly related?: readonly string[];
    readonly blockedBy?: readonly string[];
    readonly codeAnchors?: readonly { readonly enforcement: "advisory" | "required"; readonly pattern: string }[];
    readonly metadata?: Readonly<Record<string, DocumentJsonValue>>;
  };
  readonly expected: {
    readonly documentPath: string;
    readonly metadataStorage: "frontmatter";
    readonly reachability: unknown;
    readonly goldenFile?: string;
    readonly goldenDigest?: `sha256:${string}`;
  };
}

export interface DocsProtocolQualificationContractV2 {
  readonly schemaVersion: 2;
  readonly scenarios: readonly DocsProtocolQualificationScenarioV2[];
}

export interface DocsProtocolQualificationV2Request {
  readonly consumerRoot: string;
  readonly integrationPath?: string;
  readonly localDevelopment?: boolean;
  readonly signal?: AbortSignal;
}

export interface DocsProtocolQualificationReceiptV2 {
  readonly schemaVersion: 2;
  readonly receiptDigest: `sha256:${string}`;
  readonly cohortAdmissible: boolean;
  readonly evidenceClass: "local-development" | "released-cohort";
  readonly projectId: string;
  readonly scenarios: readonly { readonly id: string; readonly type: string; readonly documentPath: string; readonly outputDigest: string }[];
  readonly checks: readonly ("info" | "find" | "check" | "doctor" | "recover" | "preview" | "apply" | "path" | "reachability" | "golden" | "source-unchanged")[];
  readonly derived: {
    readonly contractPath: string;
    readonly gateCommand: string;
    readonly packageVersions: { readonly docsProtocol: string; readonly engineeringFoundation: string };
    readonly profilePath: string;
  };
  readonly evidence: {
    readonly sourceDigest: `sha256:${string}`;
    readonly integration: { readonly path: string; readonly digest: `sha256:${string}` };
    readonly contract: { readonly path: string; readonly digest: `sha256:${string}` };
    readonly profile: { readonly path: string; readonly digest: `sha256:${string}` };
    readonly skill: { readonly path: string; readonly digest: `sha256:${string}` };
    readonly packageManifestDigest: `sha256:${string}`;
    readonly lockfileDigest: `sha256:${string}`;
    readonly executingDocsProtocol: { readonly version: string; readonly buildDigest: `sha256:${string}` };
    readonly executingFoundation: { readonly version: string; readonly buildIdentity: `sha256:${string}` };
    readonly cohort: Readonly<Record<string, unknown>>;
  };
}
