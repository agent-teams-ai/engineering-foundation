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

export interface ScaffoldCompositionV1 {
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

export interface ScaffoldingConfigV1 {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly targetCatalogPath: RepositoryPath;
  readonly compositions: readonly ScaffoldCompositionV1[];
}

export interface ScaffoldIntentV1 {
  readonly schemaVersion: 1;
  readonly compositionId: string;
  readonly targetRef: string;
  readonly recipeParameters?: JsonObject;
  readonly facets?: readonly ConfiguredDefinition[];
}

export interface ScaffoldTargetV1 {
  readonly id: string;
  readonly role: string;
  readonly path: RepositoryPath;
  readonly packageName: string;
  readonly ownerDocument?: string;
}

export interface ScaffoldTargetCatalogV1 {
  readonly version: 1;
  readonly packages: readonly ScaffoldTargetV1[];
}

export interface ScaffoldDiagnosticV1 {
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

export interface ScaffoldReadAssertionV1 {
  readonly path: RepositoryPath;
  readonly state: "file";
  readonly digest: Sha256Digest;
  readonly size: number;
}

export interface MaterializeFileOperationV1 {
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

export interface ScaffoldPlanV1 {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly compiler: {
    readonly id: "@agent-teams/engineering-foundation";
    readonly version: string;
  };
  readonly projectId: string;
  readonly authority: {
    readonly configPath: RepositoryPath;
    readonly targetCatalogPath: RepositoryPath;
  };
  readonly intent: ScaffoldIntentV1;
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
  readonly target: ScaffoldTargetV1;
  readonly readSet: readonly ScaffoldReadAssertionV1[];
  readonly requiredAdapterCapabilities: readonly ["materialize-file/v1"];
  readonly operations: readonly MaterializeFileOperationV1[];
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly planDigest: Sha256Digest;
}

export type ScaffoldOperationOutcome =
  | "already-satisfied"
  | "applied"
  | "conflict"
  | "not-applied"
  | "recovered";

export interface ScaffoldOperationReceiptV1 {
  readonly operationId: string;
  readonly path: RepositoryPath;
  readonly outcome: ScaffoldOperationOutcome;
  readonly resultDigest?: Sha256Digest;
}

type ScaffoldAlreadySatisfiedOperationReceiptV1 =
  ScaffoldOperationReceiptV1 & {
    readonly outcome: "already-satisfied";
    readonly resultDigest: Sha256Digest;
  };

type ScaffoldAppliedOperationReceiptV1 = ScaffoldOperationReceiptV1 & {
  readonly outcome: "applied";
  readonly resultDigest: Sha256Digest;
};

type ScaffoldRecoveredOperationReceiptV1 =
  ScaffoldOperationReceiptV1 & {
    readonly outcome: "recovered";
    readonly resultDigest: Sha256Digest;
  };

type ScaffoldConflictOperationReceiptV1 = ScaffoldOperationReceiptV1 & {
  readonly outcome: "conflict";
  readonly resultDigest?: never;
};

type ScaffoldNotAppliedOperationReceiptV1 =
  ScaffoldOperationReceiptV1 & {
    readonly outcome: "not-applied";
    readonly resultDigest?: never;
  };

export type ScaffoldReceiptOutcome =
  | "already-applied"
  | "applied"
  | "failed-recovered"
  | "recovery-required"
  | "rejected";

interface ScaffoldReceiptCommonV1 {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly planDigest: Sha256Digest;
  readonly diagnostics: readonly ScaffoldDiagnosticV1[];
  readonly receiptDigest: Sha256Digest;
}

type ScaffoldFilesystemReceiptAdapterV1 = {
  readonly adapter: {
    readonly id: "foundation.filesystem/v1";
    readonly contractVersion: 1;
  };
};

type ScaffoldMemoryReceiptAdapterV1 = {
  readonly adapter: {
    readonly id: "foundation.memory/v1";
    readonly contractVersion: 1;
  };
};

type ScaffoldFilesystemCommittedReceiptV1 =
  ScaffoldFilesystemReceiptAdapterV1 & {
    readonly commit: {
      readonly state: "committed";
      readonly atomicity: "journaled-recoverable";
    };
  };

type ScaffoldMemoryCommittedReceiptV1 = ScaffoldMemoryReceiptAdapterV1 & {
  readonly commit: {
    readonly state: "committed";
    readonly atomicity: "memory-atomic";
  };
};

type ScaffoldFilesystemRecoveredReceiptV1 =
  ScaffoldFilesystemReceiptAdapterV1 & {
    readonly commit: {
      readonly state: "recovered";
      readonly atomicity: "journaled-recoverable";
    };
  };

type ScaffoldFilesystemRecoveryRequiredReceiptV1 =
  ScaffoldFilesystemReceiptAdapterV1 & {
    readonly commit: {
      readonly state: "recovery-required";
      readonly atomicity: "journaled-recoverable";
    };
  };

type ScaffoldFilesystemRejectedReceiptV1 =
  ScaffoldFilesystemReceiptAdapterV1 & {
    readonly commit: {
      readonly state: "rejected";
      readonly atomicity: "journaled-recoverable";
    };
  };

type ScaffoldMemoryRejectedReceiptV1 = ScaffoldMemoryReceiptAdapterV1 & {
  readonly commit: {
    readonly state: "rejected";
    readonly atomicity: "memory-atomic";
  };
};

type ScaffoldAppliedOperationReceiptsV1 = readonly [
  ScaffoldAlreadySatisfiedOperationReceiptV1 | ScaffoldAppliedOperationReceiptV1,
  ...(ScaffoldAlreadySatisfiedOperationReceiptV1 | ScaffoldAppliedOperationReceiptV1)[]
];

type ScaffoldAlreadyAppliedOperationReceiptsV1 = readonly [
  ScaffoldAlreadySatisfiedOperationReceiptV1,
  ...ScaffoldAlreadySatisfiedOperationReceiptV1[]
];

type ScaffoldFailedRecoveredOperationReceiptsV1 = readonly [
  ScaffoldAlreadySatisfiedOperationReceiptV1 | ScaffoldRecoveredOperationReceiptV1,
  ...(ScaffoldAlreadySatisfiedOperationReceiptV1 | ScaffoldRecoveredOperationReceiptV1)[]
];

type ScaffoldIncompleteOperationReceiptV1 =
  | ScaffoldAlreadySatisfiedOperationReceiptV1
  | ScaffoldConflictOperationReceiptV1
  | ScaffoldNotAppliedOperationReceiptV1;

export type ScaffoldReceiptV1 =
  | (ScaffoldReceiptCommonV1 &
      (ScaffoldFilesystemCommittedReceiptV1 | ScaffoldMemoryCommittedReceiptV1) & {
        readonly outcome: "applied";
        readonly operations: ScaffoldAppliedOperationReceiptsV1;
      })
  | (ScaffoldReceiptCommonV1 &
      (ScaffoldFilesystemCommittedReceiptV1 | ScaffoldMemoryCommittedReceiptV1) & {
        readonly outcome: "already-applied";
        readonly operations: ScaffoldAlreadyAppliedOperationReceiptsV1;
      })
  | (ScaffoldReceiptCommonV1 & ScaffoldFilesystemRecoveredReceiptV1 & {
      readonly outcome: "failed-recovered";
      readonly operations: ScaffoldFailedRecoveredOperationReceiptsV1;
    })
  | (ScaffoldReceiptCommonV1 &
      ScaffoldFilesystemRecoveryRequiredReceiptV1 & {
        readonly outcome: "recovery-required";
        readonly operations: readonly ScaffoldIncompleteOperationReceiptV1[];
      })
  | (ScaffoldReceiptCommonV1 &
      (ScaffoldFilesystemRejectedReceiptV1 | ScaffoldMemoryRejectedReceiptV1) & {
        readonly outcome: "rejected";
        readonly operations: readonly ScaffoldIncompleteOperationReceiptV1[];
      });

export interface ScaffoldCompilationInput {
  readonly foundationVersion: string;
  readonly configPath: RepositoryPath;
  readonly config: ScaffoldingConfigV1;
  readonly intent: ScaffoldIntentV1;
  readonly catalog: ScaffoldTargetCatalogV1;
  readonly authorityReadSet: readonly ScaffoldReadAssertionV1[];
}

export interface ScaffoldFileContribution {
  readonly path: RepositoryPath;
  readonly mediaType: string;
  readonly content: string;
  readonly causes: readonly string[];
}
