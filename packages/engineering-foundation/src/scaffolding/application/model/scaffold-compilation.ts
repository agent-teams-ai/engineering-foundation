import type { JsonObject, RepositoryPath, Sha256Digest } from "./scaffold-values.js";

export interface DefinitionRef {
  readonly id: string;
  readonly contractVersion: number;
}

export interface ConfiguredDefinition {
  readonly ref: DefinitionRef;
  readonly parameters?: JsonObject;
}

export interface ScaffoldRenderingComposition {
  readonly id: string;
  readonly scaffoldProfile: ConfiguredDefinition;
  readonly recipe: ConfiguredDefinition;
  readonly targetRoles: readonly string[];
  readonly fixedRecipeParameters?: JsonObject;
  readonly defaultRecipeParameters?: JsonObject;
  readonly facets?: {
    readonly fixed?: readonly ConfiguredDefinition[];
    readonly default?: readonly ConfiguredDefinition[];
    readonly allowed?: readonly DefinitionRef[];
  };
  readonly policies: readonly ConfiguredDefinition[];
}

export interface ScaffoldAuthorityVerifierV1 {
  readonly id: "foundation.markdown-yaml-owner";
  readonly contractVersion: 1;
  readonly parameters: {
    readonly allowedStatuses: readonly string[];
    readonly documentRoots: readonly string[];
  };
}

interface AuthorityScaffoldComposition extends ScaffoldRenderingComposition {
  readonly authorityVerifiers: readonly [ScaffoldAuthorityVerifierV1];
}

export interface AuthorityScaffoldingConfig {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly targetCatalogPath: RepositoryPath;
  readonly compositions: readonly AuthorityScaffoldComposition[];
}

export interface ScaffoldRenderingIntent {
  readonly schemaVersion: 1;
  readonly compositionId: string;
  readonly targetRef: string;
  readonly recipeParameters?: JsonObject;
  readonly facets?: readonly ConfiguredDefinition[];
}

export interface ScaffoldRenderingTarget {
  readonly id: string;
  readonly role: string;
  readonly path: RepositoryPath;
  readonly packageName: string;
}

interface AuthorityScaffoldOwnerDocumentBinding {
  readonly id: string;
  readonly path: RepositoryPath;
}

export interface AuthorityScaffoldTarget extends ScaffoldRenderingTarget {
  readonly ownerDocument: AuthorityScaffoldOwnerDocumentBinding;
}

export interface AuthorityScaffoldTargetCatalog {
  readonly version: 1;
  readonly packages: readonly AuthorityScaffoldTarget[];
}

export interface ScaffoldRenderingDiagnostic {
  readonly ruleId: string;
  readonly severity: "error" | "info" | "warning";
  readonly phase:
    | "apply"
    | "composition"
    | "input"
    | "planning"
    | "policy"
    | "recovery";
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
}

export type ScaffoldDiagnosticV1 = ScaffoldRenderingDiagnostic;

export interface ScaffoldReadAssertionV1 {
  readonly path: RepositoryPath;
  readonly state: "file";
  readonly digest: Sha256Digest;
  readonly size: number;
}

export type AuthorityScaffoldReadSet = readonly [
  ScaffoldReadAssertionV1,
  ScaffoldReadAssertionV1,
  ScaffoldReadAssertionV1
];

type ScaffoldAuthoritySourceRoleV1 =
  | "config"
  | "owner-document"
  | "target-catalog";

export interface ScaffoldAuthoritySourceAssertionV1 {
  readonly role: ScaffoldAuthoritySourceRoleV1;
  readonly assertion: ScaffoldReadAssertionV1;
}

export interface ScaffoldAuthorityEvidenceV1 {
  readonly schemaVersion: 1;
  readonly verifier: {
    readonly id: "foundation.markdown-yaml-owner";
    readonly contractVersion: 1;
  };
  readonly projectId: string;
  readonly targetRef: string;
  readonly targetIdentityDigest: Sha256Digest;
  readonly ownerDocument: {
    readonly id: string;
    readonly path: RepositoryPath;
    readonly status: string;
  };
  readonly sources: readonly [
    ScaffoldAuthoritySourceAssertionV1 & { readonly role: "config" },
    ScaffoldAuthoritySourceAssertionV1 & { readonly role: "owner-document" },
    ScaffoldAuthoritySourceAssertionV1 & { readonly role: "target-catalog" }
  ];
  readonly evidenceDigest: Sha256Digest;
}

export interface ScaffoldRenderingOperation {
  readonly id: string;
  readonly kind: "materialize-file";
  readonly path: RepositoryPath;
  readonly precondition: { readonly state: "absent" };
  readonly after: {
    readonly digest: Sha256Digest;
    readonly size: number;
    readonly mode: "0644";
    readonly mediaType: string;
    readonly contentBase64: string;
  };
  readonly causes: readonly string[];
}

export interface ScaffoldRenderingCompiler {
  readonly id: "@agent-teams/engineering-foundation";
  readonly version: string;
}

export interface ScaffoldRenderingCompositionSelection {
  readonly id: string;
  readonly scaffoldProfile: DefinitionRef;
  readonly recipe: DefinitionRef;
  readonly facets: readonly DefinitionRef[];
  readonly policies: readonly DefinitionRef[];
}

export interface ScaffoldRenderingDefinitionEvidence {
  readonly kind: "facet" | "policy" | "recipe" | "scaffold-profile";
  readonly ref: DefinitionRef;
  readonly contractDigest: Sha256Digest;
}

export interface ScaffoldRenderingResolution {
  readonly profileParameters: JsonObject;
  readonly recipeParameters: JsonObject;
  readonly facets: readonly {
    readonly ref: DefinitionRef;
    readonly parameters: JsonObject;
  }[];
  readonly policies: readonly {
    readonly ref: DefinitionRef;
    readonly parameters: JsonObject;
    readonly outcome: "passed";
  }[];
}

export interface AuthorityScaffoldPlan {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly compiler: ScaffoldRenderingCompiler;
  readonly projectId: string;
  readonly authority: {
    readonly configPath: RepositoryPath;
    readonly targetCatalogPath: RepositoryPath;
  };
  readonly authorityEvidence: ScaffoldAuthorityEvidenceV1;
  readonly intent: ScaffoldRenderingIntent;
  readonly intentDigest: Sha256Digest;
  readonly authoritySnapshotDigest: Sha256Digest;
  readonly composition: ScaffoldRenderingCompositionSelection;
  readonly definitions: readonly ScaffoldRenderingDefinitionEvidence[];
  readonly resolved: ScaffoldRenderingResolution;
  readonly target: AuthorityScaffoldTarget;
  readonly readSet: AuthorityScaffoldReadSet;
  readonly requiredAdapterCapabilities: readonly ["materialize-file/v1"];
  readonly operations: readonly ScaffoldRenderingOperation[];
  readonly diagnostics: readonly ScaffoldRenderingDiagnostic[];
  readonly planDigest: Sha256Digest;
}

export type ScaffoldPlan = AuthorityScaffoldPlan;

export interface AuthorityScaffoldCompilationInput {
  readonly foundationVersion: string;
  readonly configPath: RepositoryPath;
  readonly config: AuthorityScaffoldingConfig;
  readonly intent: ScaffoldRenderingIntent;
  readonly catalog: AuthorityScaffoldTargetCatalog;
  readonly authorityEvidence: ScaffoldAuthorityEvidenceV1;
  readonly authorityReadSet: AuthorityScaffoldReadSet;
}

export interface ScaffoldFileContribution {
  readonly path: RepositoryPath;
  readonly mediaType: string;
  readonly content: string;
  readonly causes: readonly string[];
}
