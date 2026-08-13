export type NodeScaffoldJournalMutation = "create" | "remove" | "replace";

export type NodeScaffoldJournalEvidence =
  | "candidate"
  | "previous"
  | "retired";

export type NodeScaffoldJournalStoreFaultPoint =
  | {
      readonly mutation: NodeScaffoldJournalMutation;
      readonly phase: "after-candidate-synced";
    }
  | {
      readonly mutation: "remove" | "replace";
      readonly phase: "before-shared-quarantine";
    }
  | {
      readonly mutation: "remove" | "replace";
      readonly phase: "after-shared-quarantine-synced";
    }
  | {
      readonly mutation: "create" | "replace";
      readonly phase: "before-canonical-link";
    }
  | {
      readonly mutation: "create" | "replace";
      readonly phase: "after-canonical-linked";
    }
  | {
      readonly mutation: "create" | "replace";
      readonly phase: "after-canonical-synced";
    }
  | {
      readonly evidence: NodeScaffoldJournalEvidence;
      readonly mutation: NodeScaffoldJournalMutation;
      readonly phase: "before-private-retirement-rename";
    }
  | {
      readonly evidence: NodeScaffoldJournalEvidence;
      readonly mutation: NodeScaffoldJournalMutation;
      readonly phase: "before-private-retirement";
    }
  | {
      readonly evidence: NodeScaffoldJournalEvidence;
      readonly mutation: NodeScaffoldJournalMutation;
      readonly phase: "before-logical-retirement";
    }
  | {
      readonly mutation: NodeScaffoldJournalMutation;
      readonly phase: "before-final-directory-sync";
    }
  | {
      readonly mutation: NodeScaffoldJournalMutation;
      readonly path: string;
      readonly phase: "before-directory-sync";
      readonly role: "destination" | "source" | "state-parent";
    }
  | {
      readonly phase: "before-reconciliation-directory-sync";
    };

export type NodeScaffoldJournalStoreFaultInjector = (
  point: NodeScaffoldJournalStoreFaultPoint
) => Promise<void> | void;
