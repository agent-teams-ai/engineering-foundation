export type NodeDocumentJournalFaultPoint =
  | { readonly phase: "after-candidate-synced" }
  | { readonly phase: "after-canonical-quarantined" }
  | { readonly phase: "after-canonical-published" }
  | { readonly phase: "after-quarantine-removed" }
  | {
      readonly operation: "create" | "remove" | "replace";
      readonly phase: "before-final-directory-sync";
    }
  | { readonly phase: "before-reconciliation-directory-sync" }
  | {
      readonly evidence: "candidate" | "quarantine";
      readonly operation: "create" | "remove" | "replace";
      readonly path: string;
      readonly phase: "before-private-cleanup";
    }
  | {
      readonly operation: "remove" | "replace";
      readonly path: string;
      readonly phase: "before-shared-quarantine";
    }
  | {
      readonly operation: "create" | "remove" | "replace";
      readonly path: string;
      readonly phase: "before-directory-sync";
      readonly role: "destination" | "source" | "state-parent";
    };

export type NodeDocumentJournalFaultInjector = (
  point: NodeDocumentJournalFaultPoint
) => Promise<void> | void;
