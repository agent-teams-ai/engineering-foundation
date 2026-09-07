import type { DocumentJsonValue, DocumentMetadataObject } from "../domain/metadata.js";
import type { DocsDiagnostic, DocsFindDocument, DocsNewRequest, DocsReceiptOutcome } from "./model.js";
import type { CompiledOutput } from "./compiled-output-reader.js";

/** Facts consumed by documentation policy, independent of the provider's catalog/runtime. */
export interface AuthoringCatalog {
  readonly projectId: string;
  readonly status: "complete" | "partial";
  readonly semanticDigest: `sha256:${string}`;
  readonly diagnostics: readonly { readonly message: string; readonly ruleId: string; readonly severity: "error"; readonly subject: string }[];
  readonly documents: readonly (Omit<DocsFindDocument, "related" | "blockedBy"> & { readonly metadata: DocumentMetadataObject })[];
}
export type AuthoringIntent = DocsNewRequest["intent"] & {
  readonly schemaVersion: 1;
  readonly related?: readonly string[];
  readonly additionalMetadata?: Readonly<Record<string, DocumentJsonValue>>;
};
/** Read-only Plan facts; the originating adapter retains the exact provider artifact for Apply. */
export interface AuthoringPlan {
  readonly schemaVersion: 2;
  readonly destination: string;
  readonly planDigest: `sha256:${string}`;
  readonly output: CompiledOutput;
  readonly authority: {
    readonly profileSemanticDigest: `sha256:${string}`;
    readonly catalogPreimageSemanticDigest: `sha256:${string}`;
    readonly expectedCatalogPostimageSemanticDigest: `sha256:${string}`;
  };
}
export interface AuthoringReceipt {
  readonly schemaVersion: 1 | 2;
  readonly outcome: DocsReceiptOutcome;
  readonly receiptDigest: `sha256:${string}`;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly commit: {
    readonly state: "committed" | "not-published" | "recovery-required" | "manual-recovery-required";
    readonly publication: "none" | "preexisting-exact" | "published" | "unknown";
    readonly recoverability: "not-required" | "preserved-for-recovery";
  };
  readonly directoryMaterialization?: {
    readonly state: "none-created" | "created-and-retained" | "preserved-unknown";
    readonly plannedDirectories: readonly string[];
    readonly observedCreatedDirectories: readonly string[];
  };
}
export type AuthoringTransaction = { readonly state: "idle" } | {
  readonly state: "recoverable";
  readonly recovery: { readonly exactFoundationVersion: string; readonly exactFoundationBuildIdentity: string };
} | {
  readonly state: "manual-recovery-required";
  readonly reason: string;
  readonly transactionKind?: "corrupt" | "document" | "local-mode" | "scaffold" | "transition-residue" | "unknown" | "version-mismatch";
  readonly recovery?: { readonly commandId: "detach" | "docs-recover" | "scaffold-recover"; readonly args: Readonly<Record<string, string>> };
};
