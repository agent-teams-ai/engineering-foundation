import type { DocumentPhysicalIdentity } from "./document-physical-identity.js";

export interface DocumentParentMaterializationPlanV2 {
  readonly policy: "create-missing-real-directories";
  readonly deepestExistingDirectory: string;
  readonly missingDirectories: readonly string[];
  readonly finalParent: string;
}

export interface DocumentCreatedDirectoryEvidenceV2 {
  readonly path: string;
  readonly identity: DocumentPhysicalIdentity;
}

export interface DocumentParentMaterializationJournalV2 {
  readonly schemaVersion: 2;
  readonly plan: DocumentParentMaterializationPlanV2;
  readonly anchorIdentity: DocumentPhysicalIdentity;
  readonly createdDirectories: readonly DocumentCreatedDirectoryEvidenceV2[];
}

export type DocumentParentMaterializationInspectionV2 =
  | {
      readonly state: "current";
      readonly nextDirectory?: string;
    }
  | {
      readonly state: "manual-recovery-required";
      readonly reason:
        | "anchor-changed"
        | "created-directory-changed"
        | "portable-name-collision"
        | "unbound-directory-exists";
      readonly path: string;
    };
