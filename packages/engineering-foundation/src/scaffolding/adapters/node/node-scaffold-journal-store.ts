import { join } from "node:path";

import {
  NodeJournalSlotStore,
  type JournalSlotFailure,
  type JournalSlotFailureContext,
  type JournalSlotFaultPoint,
  type JournalSlotSubject
} from "@agent-teams/repository-mutation/node";
import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../../foundation-state-contract.js";
import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import { syncDirectory } from "./filesystem-path-guard.js";
import {
  parseScaffoldJournal,
  scaffoldJournalRecoveryRequired,
  scaffoldQuarantinePrefix,
  scaffoldRetiredPrefix,
  serializeScaffoldJournal,
  type ScaffoldJournalAuthority,
  type ScaffoldJournalSlotObservation,
  type StoredScaffoldJournal
} from "./node-scaffold-journal-evidence.js";
import type { NodeScaffoldJournalStoreFaultInjector } from "./node-scaffold-journal-store-faults.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export type {
  ScaffoldJournalAuthority,
  ScaffoldJournalSlotObservation,
  StoredScaffoldJournal
} from "./node-scaffold-journal-evidence.js";

type NodeScaffoldJournalStoreFaultPoint =
  Parameters<NodeScaffoldJournalStoreFaultInjector>[0];

export interface NodeScaffoldJournalStoreOperations {
  readonly faultInjector?: NodeScaffoldJournalStoreFaultInjector;
  readonly syncDirectoryStrictly?: typeof syncDirectory;
}

let privateSequence = 0;

function privateEvidenceName(prefix: string): string {
  privateSequence += 1;
  return `${prefix}${process.pid}.${privateSequence}`;
}

function subjectDescription(context: JournalSlotFailureContext): string {
  const descriptions: Record<JournalSlotSubject, string> = {
    candidate: "Scaffolding journal temporary",
    canonical: "Canonical scaffolding journal",
    evidence: "Scaffolding journal evidence",
    quarantine: "Quarantined scaffolding journal",
    replacement: "Canonical scaffolding journal",
    "retired-evidence": "Retired scaffolding journal evidence"
  };
  return descriptions[context.subject ?? "canonical"];
}

function stabilizationMessage(context: JournalSlotFailureContext): string {
  if (context.mutation === "read") {
    return "Scaffolding journal mutation must be stabilized before another read.";
  }
  return context.mutation === "remove"
    ? "Scaffolding journal mutation must be stabilized before removal."
    : "Scaffolding journal mutation must be stabilized before another mutation.";
}

function residueMessage(context: JournalSlotFailureContext): string {
  if (context.mutation === "read") {
    return "Incomplete scaffolding journal transition evidence requires reconciliation.";
  }
  return context.mutation === "remove"
    ? "Scaffolding journal transition evidence must be reconciled before removal."
    : "Scaffolding journal transition evidence must be reconciled before mutation.";
}

function rawCause(context: JournalSlotFailureContext, fallback: string): Error {
  return context.cause instanceof Error
    ? context.cause
    : scaffoldJournalRecoveryRequired(fallback, context.cause);
}

const failures: Record<
  JournalSlotFailure,
  (context: JournalSlotFailureContext) => Error
> = {
  "candidate-exists": (context) => scaffoldJournalRecoveryRequired(
    "Scaffolding journal temporary already exists and was preserved.",
    context.cause
  ),
  "candidate-unavailable": (context) => scaffoldJournalRecoveryRequired(
    "Scaffolding journal temporary could not be created safely.",
    context.cause
  ),
  "canonical-recreated": () => scaffoldJournalRecoveryRequired(
    "Canonical scaffolding journal was recreated concurrently; all evidence was preserved."
  ),
  changed: (context) => scaffoldJournalRecoveryRequired(
    `${subjectDescription(context)} identity or bytes changed; all evidence was preserved.`
  ),
  "must-be-stabilized": (context) =>
    scaffoldJournalRecoveryRequired(stabilizationMessage(context)),
  "not-regular-file": () => scaffoldJournalRecoveryRequired(
    "Scaffolding journal is not a stable bounded regular file."
  ),
  "publication-conflict": (context) => scaffoldJournalRecoveryRequired(
    "Canonical scaffolding journal slot is occupied; all evidence was preserved.",
    context.cause
  ),
  "quarantine-unavailable": (context) =>
    rawCause(context, "Scaffolding journal could not enter its quarantine transition."),
  "slot-occupied": () => scaffoldJournalRecoveryRequired(
    "Canonical scaffolding journal slot is already occupied; it was preserved."
  ),
  "state-directory-missing": (context) =>
    rawCause(context, "Scaffolding state directory is missing."),
  "too-many-entries": () => scaffoldJournalRecoveryRequired(
    "Scaffolding state contains too many entries to inspect safely."
  ),
  "transition-residue": (context) =>
    scaffoldJournalRecoveryRequired(residueMessage(context))
};

function scaffoldJournalFailure(
  failure: JournalSlotFailure,
  context: JournalSlotFailureContext
): Error {
  return failures[failure](context);
}

function mapFaultPoint(
  point: JournalSlotFaultPoint
): NodeScaffoldJournalStoreFaultPoint | undefined {
  switch (point.phase) {
    case "before-reconciliation-directory-sync":
      return { phase: point.phase };
    case "after-candidate-synced":
      return { mutation: point.mutation, phase: "after-candidate-synced" };
    case "before-final-directory-sync":
      return { mutation: point.mutation, phase: "before-final-directory-sync" };
    case "before-quarantine-directory":
      return { mutation: point.mutation, phase: "before-shared-quarantine" };
    case "after-shared-quarantine-synced":
      return { mutation: point.mutation, phase: "after-shared-quarantine-synced" };
    case "before-canonical-link":
      return { mutation: point.mutation, phase: "before-canonical-link" };
    case "after-canonical-linked":
      return { mutation: point.mutation, phase: "after-canonical-linked" };
    case "after-canonical-synced":
      return { mutation: point.mutation, phase: "after-canonical-synced" };
    case "before-private-retirement":
      return { evidence: point.evidence, mutation: point.mutation, phase: "before-private-retirement" };
    case "before-private-retirement-rename":
      return { evidence: point.evidence, mutation: point.mutation, phase: "before-private-retirement-rename" };
    case "before-logical-retirement":
      return { evidence: point.evidence, mutation: point.mutation, phase: "before-logical-retirement" };
    case "before-directory-sync":
      return { mutation: point.mutation, path: point.path, phase: point.phase, role: point.role };
    case "after-final-directory-sync":
    case "before-retirement-directory":
    case "before-shared-quarantine":
      return undefined;
  }
}

/**
 * Scaffolding owner composition of the shared journal slot. The historical
 * `.tmp` candidate, `scaffold-quarantine` and `scaffold-retired` evidence
 * names, and the completed-scaffold terminal root are unchanged, so released
 * recovery evidence remains recognizable.
 */
export class NodeScaffoldJournalStore {
  readonly #store: NodeJournalSlotStore<AuthorityScaffoldJournal>;

  public constructor(
    consumerRoot: string,
    operations: NodeScaffoldJournalStoreOperations = {}
  ) {
    const parent = join(consumerRoot, LOCAL_STATE_DIRECTORY);
    const { faultInjector } = operations;
    this.#store = new NodeJournalSlotStore<AuthorityScaffoldJournal>({
      canonicalPath: join(parent, FOUNDATION_TRANSACTION_FILE),
      codec: { parse: parseScaffoldJournal, serialize: serializeScaffoldJournal },
      failure: scaffoldJournalFailure,
      ...(faultInjector === undefined
        ? {}
        : {
            faultInjector: (point: JournalSlotFaultPoint) => {
              const mapped = mapFaultPoint(point);
              return mapped === undefined ? undefined : faultInjector(mapped);
            }
          }),
      maximumBytes: MAX_SCAFFOLD_PLAN_BYTES,
      naming: {
        candidatePath: join(parent, FOUNDATION_TRANSACTION_TEMPORARY_FILE),
        quarantineDirectoryName: () => privateEvidenceName(scaffoldQuarantinePrefix),
        residues: [
          { exact: FOUNDATION_TRANSACTION_TEMPORARY_FILE },
          { exact: `${FOUNDATION_TRANSACTION_FILE}.document-transition` },
          { prefix: `${FOUNDATION_TRANSACTION_FILE}.document-quarantine.` },
          { prefix: `${FOUNDATION_TRANSACTION_FILE}.document-retired.` },
          { prefix: scaffoldQuarantinePrefix },
          { prefix: scaffoldRetiredPrefix }
        ],
        retiredDirectoryName: () => privateEvidenceName(scaffoldRetiredPrefix),
        terminalRootName: `${FOUNDATION_TRANSACTION_FILE}.completed-scaffold-evidence`
      },
      canonicalInspection: "parsed",
      observableSyncStages: ["candidate", "final", "publication", "transition"],
      reconciliation: "sticky-pending",
      syncDirectory: operations.syncDirectoryStrictly ?? syncDirectory
    });
  }

  public read(): Promise<StoredScaffoldJournal | undefined> {
    return this.#store.read();
  }

  public stabilizeForReconciliation(): Promise<ScaffoldJournalSlotObservation> {
    return this.#store.stabilizeForReconciliation();
  }

  public create(
    journal: AuthorityScaffoldJournal
  ): Promise<ScaffoldJournalAuthority> {
    return this.#store.create(journal);
  }

  public replace(
    expected: ScaffoldJournalAuthority,
    journal: AuthorityScaffoldJournal
  ): Promise<ScaffoldJournalAuthority> {
    return this.#store.replace(expected, journal);
  }

  public remove(expected: ScaffoldJournalAuthority): Promise<void> {
    return this.#store.remove(expected);
  }
}
