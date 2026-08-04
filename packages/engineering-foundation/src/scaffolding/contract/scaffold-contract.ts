import type {
  ConfiguredDefinition,
  DefinitionRef,
  JsonObject,
  RepositoryPath,
  Sha256Digest
} from "./types.js";

export interface ScaffoldAuthorityVerifier {
  readonly id: "foundation.markdown-yaml-owner";
  readonly contractVersion: 1;
  readonly parameters: {
    readonly allowedStatuses: readonly string[];
    readonly documentRoots: readonly RepositoryPath[];
  };
}

export interface ScaffoldComposition {
  readonly id: string;
  readonly scaffoldProfile: ConfiguredDefinition;
  readonly recipe: ConfiguredDefinition;
  readonly targetRoles: readonly string[];
  readonly authorityVerifiers: readonly [ScaffoldAuthorityVerifier];
  readonly fixedRecipeParameters?: JsonObject;
  readonly defaultRecipeParameters?: JsonObject;
  readonly facets?: {
    readonly fixed?: readonly ConfiguredDefinition[];
    readonly default?: readonly ConfiguredDefinition[];
    readonly allowed?: readonly DefinitionRef[];
  };
  readonly policies: readonly ConfiguredDefinition[];
}

export interface ScaffoldingConfig {
  readonly schemaVersion: 2;
  readonly projectId: string;
  readonly targetCatalogPath: RepositoryPath;
  readonly compositions: readonly ScaffoldComposition[];
}

export interface ScaffoldIntent {
  readonly schemaVersion: 1;
  readonly compositionId: string;
  readonly targetRef: string;
  readonly recipeParameters?: JsonObject;
  readonly facets?: readonly ConfiguredDefinition[];
}

export interface ScaffoldOwnerDocumentBinding {
  readonly id: string;
  readonly path: RepositoryPath;
}

export interface ScaffoldTarget {
  readonly id: string;
  readonly role: string;
  readonly path: RepositoryPath;
  readonly packageName: string;
  readonly ownerDocument: ScaffoldOwnerDocumentBinding;
}

export interface ScaffoldTargetCatalog {
  readonly version: 2;
  readonly packages: readonly ScaffoldTargetCatalogEntry[];
}

export interface ScaffoldTargetCatalogEntry {
  readonly id: string;
  readonly role: string;
  readonly path: RepositoryPath;
  readonly packageName: string;
  readonly ownerDocumentId: string;
}

export interface ScaffoldDiagnostic {
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

export interface ScaffoldReadAssertion {
  readonly path: RepositoryPath;
  readonly state: "file";
  readonly digest: Sha256Digest;
  readonly size: number;
}

export type ScaffoldAuthorityReadSet = readonly [
  ScaffoldReadAssertion,
  ScaffoldReadAssertion,
  ScaffoldReadAssertion
];

export type ScaffoldAuthoritySourceRole =
  | "config"
  | "owner-document"
  | "target-catalog";

export interface ScaffoldAuthoritySourceAssertion {
  readonly role: ScaffoldAuthoritySourceRole;
  readonly assertion: ScaffoldReadAssertion;
}

export interface ScaffoldAuthorityEvidence {
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
    ScaffoldAuthoritySourceAssertion & { readonly role: "config" },
    ScaffoldAuthoritySourceAssertion & { readonly role: "owner-document" },
    ScaffoldAuthoritySourceAssertion & { readonly role: "target-catalog" }
  ];
  readonly evidenceDigest: Sha256Digest;
}

export interface MaterializeFileOperation {
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

export interface ScaffoldPlan {
  readonly schemaVersion: 2;
  readonly protocolVersion: 2;
  readonly compiler: {
    readonly id: "@agent-teams/engineering-foundation";
    readonly version: string;
  };
  readonly projectId: string;
  readonly authority: {
    readonly configPath: RepositoryPath;
    readonly targetCatalogPath: RepositoryPath;
  };
  readonly authorityEvidence: ScaffoldAuthorityEvidence;
  readonly intent: ScaffoldIntent;
  readonly intentDigest: Sha256Digest;
  readonly authoritySnapshotDigest: Sha256Digest;
  readonly composition: {
    readonly id: string;
    readonly scaffoldProfile: DefinitionRef;
    readonly recipe: DefinitionRef;
    readonly facets: readonly DefinitionRef[];
    readonly policies: readonly DefinitionRef[];
  };
  readonly definitions: readonly {
    readonly kind: "facet" | "policy" | "recipe" | "scaffold-profile";
    readonly ref: DefinitionRef;
    readonly contractDigest: Sha256Digest;
  }[];
  readonly resolved: {
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
  };
  readonly target: ScaffoldTarget;
  readonly readSet: ScaffoldAuthorityReadSet;
  readonly requiredAdapterCapabilities: readonly ["materialize-file/v1"];
  readonly operations: readonly MaterializeFileOperation[];
  readonly diagnostics: readonly ScaffoldDiagnostic[];
  readonly planDigest: Sha256Digest;
}

export type ScaffoldOperationOutcome =
  | "already-satisfied"
  | "applied"
  | "conflict"
  | "not-applied"
  | "recovered"
  | "unobserved";

export interface ScaffoldOperationReceipt {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly outcome: ScaffoldOperationOutcome;
  readonly resultDigest?: Sha256Digest;
}

export type ScaffoldAppliedOperationReceipt = ScaffoldOperationReceipt & {
  readonly outcome: "applied";
  readonly resultDigest: Sha256Digest;
};

export type ScaffoldSatisfiedOperationReceipt = ScaffoldOperationReceipt & {
  readonly outcome: "already-satisfied" | "applied";
  readonly resultDigest: Sha256Digest;
};

export type ScaffoldReceiptOutcome =
  | "already-applied"
  | "applied"
  | "authority-stale"
  | "failed-recovered"
  | "recovery-required"
  | "rejected";

export interface ScaffoldReceiptCommon {
  readonly schemaVersion: 2;
  readonly protocolVersion: 2;
  readonly planDigest: Sha256Digest;
  readonly adapter: {
    readonly id: "foundation.filesystem/v1";
    readonly contractVersion: 1;
  };
  readonly diagnostics: readonly ScaffoldDiagnostic[];
  readonly receiptDigest: Sha256Digest;
}

export type ScaffoldReceipt =
  | (ScaffoldReceiptCommon & {
      readonly outcome: "applied";
      readonly commit: {
        readonly state: "committed";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        ScaffoldAppliedOperationReceipt,
        ...ScaffoldSatisfiedOperationReceipt[]
      ];
    })
  | (ScaffoldReceiptCommon & {
      readonly outcome: "already-applied";
      readonly commit: {
        readonly state: "committed";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        ScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied";
          readonly resultDigest: Sha256Digest;
        },
        ...(ScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied";
          readonly resultDigest: Sha256Digest;
        })[]
      ];
    })
  | (ScaffoldReceiptCommon & {
      readonly outcome: "failed-recovered";
      readonly commit: {
        readonly state: "recovered";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        ScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied" | "recovered";
          readonly resultDigest: Sha256Digest;
        },
        ...(ScaffoldOperationReceipt & {
          readonly outcome: "already-satisfied" | "recovered";
          readonly resultDigest: Sha256Digest;
        })[]
      ];
    })
  | (ScaffoldReceiptCommon & {
      readonly outcome: "recovery-required";
      readonly commit: {
        readonly state: "recovery-required";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        | (ScaffoldOperationReceipt & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          })
        | (ScaffoldOperationReceipt & {
            readonly outcome: "conflict" | "not-applied" | "unobserved";
            readonly resultDigest?: never;
          }),
        ...(
          | (ScaffoldOperationReceipt & {
              readonly outcome: "already-satisfied";
              readonly resultDigest: Sha256Digest;
            })
          | (ScaffoldOperationReceipt & {
              readonly outcome: "conflict" | "not-applied" | "unobserved";
              readonly resultDigest?: never;
            })
        )[]
      ];
    })
  | (ScaffoldReceiptCommon & {
      readonly outcome: "rejected";
      readonly commit: {
        readonly state: "rejected";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly (
        | (ScaffoldOperationReceipt & {
            readonly outcome: "already-satisfied";
            readonly resultDigest: Sha256Digest;
          })
        | (ScaffoldOperationReceipt & {
            readonly outcome: "conflict" | "not-applied";
            readonly resultDigest?: never;
          })
      )[];
    })
  | (ScaffoldReceiptCommon & {
      readonly outcome: "authority-stale";
      readonly commit: {
        readonly state: "rolled-back";
        readonly atomicity: "journaled-recoverable";
      };
      readonly operations: readonly [
        ScaffoldOperationReceipt & {
          readonly outcome: "not-applied";
          readonly resultDigest?: never;
        },
        ...(ScaffoldOperationReceipt & {
          readonly outcome: "not-applied";
          readonly resultDigest?: never;
        })[]
      ];
    });

export type ScaffoldJournalOperationState =
  | "pending"
  | "preexisting"
  | "published"
  | "publishing";

export interface ScaffoldJournalOperation {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly state: ScaffoldJournalOperationState;
}

export interface ScaffoldJournal {
  readonly schemaVersion: 2;
  readonly state: "PREPARED";
  readonly plan: ScaffoldPlan;
  readonly operations: readonly ScaffoldJournalOperation[];
}

export interface ScaffoldCompilationInput {
  readonly foundationVersion: string;
  readonly configPath: RepositoryPath;
  readonly config: ScaffoldingConfig;
  readonly intent: ScaffoldIntent;
  readonly catalog: ScaffoldTargetCatalog;
  readonly authorityEvidence: ScaffoldAuthorityEvidence;
  readonly authorityReadSet: ScaffoldAuthorityReadSet;
}
