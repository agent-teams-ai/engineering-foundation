export type { AuthorityScaffoldReceipt } from "./receipt-authority-types.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Sha256Digest = `sha256:${string}`;
export type RepositoryPath = string;

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

interface ScaffoldCompositionV1 extends ScaffoldRenderingComposition {}

export interface ScaffoldingConfigV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly targetCatalogPath: RepositoryPath;
  readonly compositions: readonly ScaffoldCompositionV1[];
}

/**
 * A closed, Foundation-owned verifier selected by a consumer composition.
 * Consumer input can constrain a verifier, but cannot provide executable
 * verification behavior.
 */
export interface ScaffoldAuthorityVerifierV1 {
  readonly id: "foundation.markdown-yaml-owner";
  readonly contractVersion: 1;
  readonly parameters: {
    readonly allowedStatuses: readonly string[];
  };
}

interface AuthorityScaffoldComposition extends ScaffoldRenderingComposition {
  readonly authorityVerifiers: readonly [ScaffoldAuthorityVerifierV1];
}

export interface AuthorityScaffoldingConfig {
  readonly schemaVersion: 2;
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

export interface ScaffoldIntentV1 extends ScaffoldRenderingIntent {}

export interface ScaffoldRenderingTarget {
  readonly id: string;
  readonly role: string;
  readonly path: RepositoryPath;
  readonly packageName: string;
}

interface ScaffoldTargetV1 extends ScaffoldRenderingTarget {
  readonly ownerDocument?: string;
}

export interface ScaffoldTargetCatalogV1 {
  readonly version: 1;
  readonly packages: readonly ScaffoldTargetV1[];
}

interface AuthorityScaffoldOwnerDocumentBinding {
  readonly id: string;
  readonly path: RepositoryPath;
}

export interface AuthorityScaffoldTarget extends ScaffoldRenderingTarget {
  readonly ownerDocument: AuthorityScaffoldOwnerDocumentBinding;
}

export interface AuthorityScaffoldTargetCatalog {
  readonly version: 2;
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

export interface ScaffoldDiagnosticV1 extends ScaffoldRenderingDiagnostic {}

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

/**
 * Evidence is an immutable result of Foundation re-reading the consumer's
 * canonical sources. It is not a consumer-produced approval assertion.
 */
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

export interface MaterializeFileOperationV1 extends ScaffoldRenderingOperation {}

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

export interface ScaffoldPlanV1 {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly compiler: ScaffoldRenderingCompiler;
  readonly projectId: string;
  readonly authority: {
    readonly configPath: RepositoryPath;
    readonly targetCatalogPath: RepositoryPath;
  };
  readonly intent: ScaffoldIntentV1;
  readonly intentDigest: Sha256Digest;
  readonly authoritySnapshotDigest: Sha256Digest;
  readonly composition: ScaffoldRenderingCompositionSelection;
  readonly definitions: readonly ScaffoldRenderingDefinitionEvidence[];
  readonly resolved: ScaffoldRenderingResolution;
  readonly target: ScaffoldTargetV1;
  readonly readSet: readonly ScaffoldReadAssertionV1[];
  readonly requiredAdapterCapabilities: readonly ["materialize-file/v1"];
  readonly operations: readonly MaterializeFileOperationV1[];
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly planDigest: Sha256Digest;
}

export interface AuthorityScaffoldPlan {
  readonly schemaVersion: 2;
  readonly protocolVersion: 2;
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

export type ScaffoldPlan = ScaffoldPlanV1 | AuthorityScaffoldPlan;

export type ScaffoldOperationOutcome =
  | "already-satisfied"
  | "applied"
  | "conflict"
  | "not-applied"
  | "recovered";

export type AuthorityScaffoldOperationOutcome =
  | ScaffoldOperationOutcome
  | "unobserved";

export interface ScaffoldOperationReceiptV1 {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly outcome: ScaffoldOperationOutcome;
  readonly resultDigest?: Sha256Digest;
}

export interface AuthorityScaffoldOperationReceipt {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly outcome: AuthorityScaffoldOperationOutcome;
  readonly resultDigest?: Sha256Digest;
}

export type ScaffoldReceiptOutcome =
  | "already-applied"
  | "applied"
  | "failed-recovered"
  | "recovery-required"
  | "rejected";

export type AuthorityScaffoldReceiptOutcome =
  | ScaffoldReceiptOutcome
  | "authority-stale";

interface ScaffoldReceiptCommonV1 {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly planDigest: Sha256Digest;
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly receiptDigest: Sha256Digest;
}

// The schema and runtime validator additionally require an applied Receipt to
// contain at least one `applied` operation at any array position.
export type ScaffoldReceiptV1 =
  | (ScaffoldReceiptCommonV1 &
      {
        readonly outcome: "applied";
        readonly operations: readonly [
          ScaffoldOperationReceiptV1 & {
            readonly outcome: "already-satisfied" | "applied";
            readonly resultDigest: Sha256Digest;
          },
          ...(ScaffoldOperationReceiptV1 & {
            readonly outcome: "already-satisfied" | "applied";
            readonly resultDigest: Sha256Digest;
          })[]
        ];
      } & (
        | {
            readonly adapter: {
              readonly id: "foundation.filesystem/v1";
              readonly contractVersion: 1;
            };
            readonly commit: {
              readonly state: "committed";
              readonly atomicity: "journaled-recoverable";
            };
          }
        | {
            readonly adapter: {
              readonly id: "foundation.memory/v1";
              readonly contractVersion: 1;
            };
            readonly commit: {
              readonly state: "committed";
              readonly atomicity: "memory-atomic";
            };
          }
      ))
  | (ScaffoldReceiptCommonV1 &
      {
        readonly outcome: "already-applied";
        readonly operations: readonly [
          ScaffoldOperationReceiptV1 & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          },
          ...(ScaffoldOperationReceiptV1 & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          })[]
        ];
      } & (
        | {
            readonly adapter: {
              readonly id: "foundation.filesystem/v1";
              readonly contractVersion: 1;
            };
            readonly commit: {
              readonly state: "committed";
              readonly atomicity: "journaled-recoverable";
            };
          }
        | {
            readonly adapter: {
              readonly id: "foundation.memory/v1";
              readonly contractVersion: 1;
            };
            readonly commit: {
              readonly state: "committed";
              readonly atomicity: "memory-atomic";
            };
          }
      ))
  | (ScaffoldReceiptCommonV1 & {
      readonly adapter: {
        readonly id: "foundation.filesystem/v1";
        readonly contractVersion: 1;
      };
      readonly outcome: "failed-recovered";
      readonly commit: {
        readonly state: "recovered";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        ScaffoldOperationReceiptV1 & {
          readonly outcome: "already-satisfied" | "recovered";
          readonly resultDigest: Sha256Digest;
        },
        ...(ScaffoldOperationReceiptV1 & {
          readonly outcome: "already-satisfied" | "recovered";
          readonly resultDigest: Sha256Digest;
        })[]
      ];
    })
  | (ScaffoldReceiptCommonV1 & {
      readonly adapter: {
        readonly id: "foundation.filesystem/v1";
        readonly contractVersion: 1;
      };
      readonly outcome: "recovery-required";
      readonly commit: {
        readonly state: "recovery-required";
        readonly atomicity: "journaled-recoverable";
      };
      // Schema and runtime additionally require at least one unresolved entry.
      readonly operations: readonly [
        | (ScaffoldOperationReceiptV1 & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          })
        | (ScaffoldOperationReceiptV1 & {
            readonly outcome: "conflict" | "not-applied";
            readonly resultDigest?: never;
          }),
        ...(
          | (ScaffoldOperationReceiptV1 & {
              readonly outcome: "already-satisfied";
              readonly resultDigest: Sha256Digest;
            })
          | (ScaffoldOperationReceiptV1 & {
              readonly outcome: "conflict" | "not-applied";
              readonly resultDigest?: never;
            })
        )[]
      ];
    })
  | (ScaffoldReceiptCommonV1 &
      {
        readonly outcome: "rejected";
        readonly operations: readonly (
          | (ScaffoldOperationReceiptV1 & {
              readonly outcome: "already-satisfied";
              readonly resultDigest: Sha256Digest;
            })
          | (ScaffoldOperationReceiptV1 & {
              readonly outcome: "conflict" | "not-applied";
              readonly resultDigest?: never;
            })
        )[];
      } & (
        | {
            readonly adapter: {
              readonly id: "foundation.filesystem/v1";
              readonly contractVersion: 1;
            };
            readonly commit: {
              readonly state: "rejected";
              readonly atomicity: "journaled-recoverable";
            };
          }
        | {
            readonly adapter: {
              readonly id: "foundation.memory/v1";
              readonly contractVersion: 1;
            };
            readonly commit: {
              readonly state: "rejected";
              readonly atomicity: "memory-atomic";
            };
          }
      ));

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
  readonly schemaVersion: 2;
  readonly state: "PREPARED";
  readonly plan: AuthorityScaffoldPlan;
  readonly operations: readonly AuthorityScaffoldJournalOperation[];
}

export interface ScaffoldCompilationInput {
  readonly foundationVersion: string;
  readonly configPath: RepositoryPath;
  readonly config: ScaffoldingConfigV1;
  readonly intent: ScaffoldIntentV1;
  readonly catalog: ScaffoldTargetCatalogV1;
  readonly authorityReadSet: readonly ScaffoldReadAssertionV1[];
}

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
