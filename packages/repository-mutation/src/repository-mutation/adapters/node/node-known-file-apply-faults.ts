export type KnownFileTransactionFaultPoint =
  | {
      readonly phase:
        | "after-barrier-acquired"
        | "after-journal-created"
        | "after-journal-committed"
        | "after-journal-retired";
    }
  | {
      readonly phase:
        | "after-directory-created"
        | "after-directory-created-unbound"
        | "after-directory-authorized"
        | "after-temporary-authorized"
        | "after-temporary-synced"
        | "after-temporary-created-unbound"
        | "after-capture-ready"
        | "after-capture-created-unbound"
        | "after-capture-authorized"
        | "after-preimage-captured"
        | "after-preimage-linked-unbound"
        | "after-rollback-temporary-created-unbound"
        | "after-rollback-temporary-ready"
        | "after-destination-captured"
        | "after-destination-retired"
        | "after-operation-publishing"
        | "after-postimage-linked"
        | "after-operation-published"
        | "after-committed-capture-unlinked";
      readonly operationIndex: number;
      readonly path: string;
    };

export type KnownFileTransactionFaultInjector = (
  point: KnownFileTransactionFaultPoint
) => Promise<void> | void;
