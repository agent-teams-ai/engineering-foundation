import { link, mkdir, open, rename } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  FOUNDATION_TRANSACTION_FILE,
  FOUNDATION_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY
} from "../../../foundation-state-contract.js";
import type { AuthorityScaffoldJournal } from "../../contract/types.js";
import { captureFileHandleIdentity } from "./filesystem-file-identity.js";
import { syncDirectoryStrictly } from "../../../repository-mutation/adapters/node/node-directory-durability.js";
import {
  createPrivateScaffoldJournalEvidencePath,
  observeScaffoldJournalAuthority,
  readStoredScaffoldJournal,
  scaffoldJournalAuthority,
  scaffoldJournalErrorCode,
  scaffoldJournalRecoveryRequired,
  scaffoldJournalResidueNames,
  scaffoldQuarantinePrefix,
  scaffoldRetiredPrefix,
  serializeScaffoldJournal,
  type ScaffoldJournalAuthority,
  type ScaffoldJournalSlotObservation,
  type StoredScaffoldJournal
} from "./node-scaffold-journal-evidence.js";
import type {
  NodeScaffoldJournalEvidence,
  NodeScaffoldJournalMutation,
  NodeScaffoldJournalStoreFaultInjector
} from "./node-scaffold-journal-store-faults.js";
import {
  classifyCleanScaffoldJournalMutation,
  sameScaffoldJournalAuthority,
  type PendingScaffoldJournalMutation
} from "./node-scaffold-journal-reconciliation.js";

export type {
  ScaffoldJournalAuthority,
  ScaffoldJournalSlotObservation,
  StoredScaffoldJournal
} from "./node-scaffold-journal-evidence.js";

export interface NodeScaffoldJournalStoreOperations {
  readonly faultInjector?: NodeScaffoldJournalStoreFaultInjector;
  readonly syncDirectoryStrictly?: typeof syncDirectoryStrictly;
}

export class NodeScaffoldJournalStore {
  readonly #candidatePath: string;
  readonly #parent: string;
  readonly #path: string;
  readonly #operations: NodeScaffoldJournalStoreOperations;
  #pending: PendingScaffoldJournalMutation | undefined;

  public constructor(
    consumerRoot: string,
    operations: NodeScaffoldJournalStoreOperations = {}
  ) {
    this.#parent = join(consumerRoot, LOCAL_STATE_DIRECTORY);
    this.#path = join(this.#parent, FOUNDATION_TRANSACTION_FILE);
    this.#candidatePath = join(
      this.#parent,
      FOUNDATION_TRANSACTION_TEMPORARY_FILE
    );
    this.#operations = {
      ...operations,
      syncDirectoryStrictly:
        operations.syncDirectoryStrictly ?? syncDirectoryStrictly
    };
  }

  public async read(): Promise<StoredScaffoldJournal | undefined> {
    if (this.#pending !== undefined) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal mutation must be stabilized before another read."
      );
    }
    const residues = await scaffoldJournalResidueNames(this.#parent);
    if (residues.length !== 0) {
      throw scaffoldJournalRecoveryRequired(
        "Incomplete scaffolding journal transition evidence requires reconciliation."
      );
    }
    return readStoredScaffoldJournal(this.#path);
  }

  public async stabilizeForReconciliation(): Promise<ScaffoldJournalSlotObservation> {
    await this.#operations.faultInjector?.({
      phase: "before-reconciliation-directory-sync"
    });
    await this.#operations.syncDirectoryStrictly?.(this.#parent);
    const observedResidues = await scaffoldJournalResidueNames(this.#parent);
    const canonical = await readStoredScaffoldJournal(this.#path);
    if (observedResidues.length !== 0) {
      return {
        ...(canonical === undefined ? {} : { canonical }),
        outcome: "recovery-required",
        residueNames: observedResidues
      };
    }
    const pending = this.#pending;
    if (pending === undefined) {
      return {
        outcome: "stable",
        ...(canonical === undefined ? {} : { stored: canonical })
      };
    }
    const outcome = classifyCleanScaffoldJournalMutation(pending, canonical);
    if (outcome === "recovery-required") {
      return {
        ...(canonical === undefined ? {} : { canonical }),
        outcome,
        residueNames: []
      };
    }
    this.#pending = undefined;
    return {
      outcome,
      ...(canonical === undefined ? {} : { stored: canonical })
    };
  }

  public create(
    journal: AuthorityScaffoldJournal
  ): Promise<ScaffoldJournalAuthority> {
    return this.#mutate("create", undefined, journal);
  }

  public replace(
    expected: ScaffoldJournalAuthority,
    journal: AuthorityScaffoldJournal
  ): Promise<ScaffoldJournalAuthority> {
    return this.#mutate("replace", expected, journal);
  }

  public async remove(expected: ScaffoldJournalAuthority): Promise<void> {
    if (this.#pending !== undefined) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal mutation must be stabilized before removal."
      );
    }
    const residues = await scaffoldJournalResidueNames(this.#parent);
    if (residues.length !== 0) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal transition evidence must be reconciled before removal."
      );
    }
    const prior = await this.#requireStored(
      this.#path,
      expected,
      "Canonical scaffolding journal"
    );
    this.#pending = { kind: "remove", prior };
      await this.#operations.faultInjector?.({
        mutation: "remove",
        phase: "before-shared-quarantine"
      });
      await this.#prove(this.#path, expected, "Canonical scaffolding journal");
      const quarantine = await createPrivateScaffoldJournalEvidencePath(
        this.#parent,
        scaffoldQuarantinePrefix
      );
      await this.#prove(this.#path, expected, "Canonical scaffolding journal");
      await rename(this.#path, quarantine.path);
      await this.#syncRenameBoundary(
        quarantine.directory,
        this.#parent,
        "remove"
      );
      await this.#prove(
        quarantine.path,
        expected,
        "Quarantined scaffolding journal"
      );
      await this.#operations.faultInjector?.({
        mutation: "remove",
        phase: "after-shared-quarantine-synced"
      });
      await this.#retire(
        quarantine.path,
        quarantine.directory,
        expected,
        "remove",
        "previous"
      );
      await this.#proveMissing(this.#path, "Canonical scaffolding journal");
      await this.#operations.faultInjector?.({
        mutation: "remove",
        phase: "before-final-directory-sync"
      });
      await this.#proveMissing(this.#path, "Canonical scaffolding journal");
      await this.#syncDirectory(
        this.#parent,
        "remove",
        "state-parent"
      );
      await this.#proveMissing(this.#path, "Canonical scaffolding journal");
    this.#pending = undefined;
  }

  async #mutate(
    mutation: "create" | "replace",
    expected: ScaffoldJournalAuthority | undefined,
    journal: AuthorityScaffoldJournal
  ): Promise<ScaffoldJournalAuthority> {
    if (this.#pending !== undefined) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal mutation must be stabilized before another mutation."
      );
    }
    const residues = await scaffoldJournalResidueNames(this.#parent);
    if (residues.length !== 0) {
      throw scaffoldJournalRecoveryRequired(
        "Scaffolding journal transition evidence must be reconciled before mutation."
      );
    }
    const bytes = await serializeScaffoldJournal(journal);
    if (
      expected === undefined &&
      (await readStoredScaffoldJournal(this.#path)) !== undefined
    ) {
      throw scaffoldJournalRecoveryRequired(
        "Canonical scaffolding journal slot is already occupied; it was preserved."
      );
    }
    const prior = expected === undefined
      ? undefined
      : await this.#requireStored(
          this.#path,
          expected,
          "Canonical scaffolding journal"
        );
    this.#pending = expected === undefined
      ? { kind: "create" }
      : { kind: "replace", prior: prior! };
    const candidate = await this.#prepareCandidate(bytes, mutation);
    this.#pending.intendedAuthority = candidate;
    let previous:
      | {
          readonly authority: ScaffoldJournalAuthority;
          readonly directory: string;
          readonly path: string;
        }
      | undefined;
    if (expected !== undefined) {
        await this.#operations.faultInjector?.({
          mutation: "replace",
          phase: "before-shared-quarantine"
        });
        await this.#prove(this.#path, expected, "Canonical scaffolding journal");
        const evidence = await createPrivateScaffoldJournalEvidencePath(
          this.#parent,
          scaffoldQuarantinePrefix
        );
        await this.#prove(this.#path, expected, "Canonical scaffolding journal");
        await rename(this.#path, evidence.path);
        await this.#syncRenameBoundary(
          evidence.directory,
          this.#parent,
          "replace"
        );
        await this.#prove(
          evidence.path,
          expected,
          "Quarantined scaffolding journal"
        );
        previous = { authority: expected, ...evidence };
        await this.#operations.faultInjector?.({
          mutation: "replace",
          phase: "after-shared-quarantine-synced"
        });
      }
      await this.#operations.faultInjector?.({
        mutation,
        phase: "before-canonical-link"
      });
      await this.#prove(
        this.#candidatePath,
        candidate,
        "Scaffolding journal temporary"
      );
      try {
        await link(this.#candidatePath, this.#path);
      } catch (error) {
        throw scaffoldJournalRecoveryRequired(
          "Canonical scaffolding journal slot is occupied; all evidence was preserved.",
          error
        );
      }
      await this.#prove(this.#path, candidate, "Canonical scaffolding journal");
      await this.#operations.faultInjector?.({
        mutation,
        phase: "after-canonical-linked"
      });
      await this.#syncDirectory(
        this.#parent,
        mutation,
        "state-parent"
      );
      await this.#operations.faultInjector?.({
        mutation,
        phase: "after-canonical-synced"
      });
      await this.#retire(
        this.#candidatePath,
        this.#parent,
        candidate,
        mutation,
        "candidate"
      );
      if (previous !== undefined) {
        await this.#retire(
          previous.path,
          previous.directory,
          previous.authority,
          mutation,
          "previous"
        );
      }
      await this.#prove(this.#path, candidate, "Canonical scaffolding journal");
      await this.#operations.faultInjector?.({
        mutation,
        phase: "before-final-directory-sync"
      });
      await this.#prove(this.#path, candidate, "Canonical scaffolding journal");
      await this.#syncDirectory(
        this.#parent,
        mutation,
        "state-parent"
      );
      await this.#prove(this.#path, candidate, "Canonical scaffolding journal");
    this.#pending = undefined;
    return candidate;
  }

  async #prepareCandidate(
    bytes: Buffer,
    mutation: "create" | "replace"
  ): Promise<ScaffoldJournalAuthority> {
    let handle;
    try {
      handle = await open(this.#candidatePath, "wx", 0o600);
    } catch (error) {
      throw scaffoldJournalRecoveryRequired(
        error instanceof Error && "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "Scaffolding journal temporary already exists and was preserved."
          : "Scaffolding journal temporary could not be created safely.",
        error
      );
    }
    let candidate: ScaffoldJournalAuthority;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      candidate = scaffoldJournalAuthority(
        await captureFileHandleIdentity(handle),
        bytes
      );
    } finally {
      await handle.close();
    }
    await this.#prove(
      this.#candidatePath,
      candidate,
      "Scaffolding journal temporary"
    );
    await this.#syncDirectory(
      this.#parent,
      mutation,
      "state-parent"
    );
    await this.#operations.faultInjector?.({
      mutation,
      phase: "after-candidate-synced"
    });
    await this.#prove(
      this.#candidatePath,
      candidate,
      "Scaffolding journal temporary"
    );
    return candidate;
  }

  async #prove(
    path: string,
    expected: ScaffoldJournalAuthority,
    description: string
  ): Promise<void> {
    if ((await observeScaffoldJournalAuthority(path, expected)) !== "match") {
      throw scaffoldJournalRecoveryRequired(
        `${description} identity or bytes changed; all evidence was preserved.`
      );
    }
  }

  async #requireStored(
    path: string,
    expected: ScaffoldJournalAuthority,
    description: string
  ): Promise<StoredScaffoldJournal> {
    const stored = await readStoredScaffoldJournal(path);
    if (
      stored === undefined ||
      !sameScaffoldJournalAuthority(stored.authority, expected)
    ) {
      throw scaffoldJournalRecoveryRequired(
        `${description} identity or bytes changed; all evidence was preserved.`
      );
    }
    return stored;
  }

  async #proveMissing(path: string, description: string): Promise<void> {
    if ((await readStoredScaffoldJournal(path)) !== undefined) {
      throw scaffoldJournalRecoveryRequired(
        `${description} was recreated concurrently; all evidence was preserved.`
      );
    }
  }

  async #retire(
    path: string,
    sourceDirectory: string,
    expected: ScaffoldJournalAuthority,
    mutation: NodeScaffoldJournalMutation,
    evidence: NodeScaffoldJournalEvidence
  ): Promise<void> {
    await this.#prove(path, expected, "Scaffolding journal evidence");
    const retired = await createPrivateScaffoldJournalEvidencePath(
      this.#parent,
      scaffoldRetiredPrefix
    );
    await this.#operations.faultInjector?.({
      evidence,
      mutation,
      phase: "before-private-retirement"
    });
    await this.#operations.faultInjector?.({
      evidence,
      mutation,
      phase: "before-private-retirement-rename"
    });
    await this.#prove(path, expected, "Scaffolding journal evidence");
    await rename(path, retired.path);
    await this.#syncRenameBoundary(
      retired.directory,
      sourceDirectory,
      mutation
    );
    await this.#prove(retired.path, expected, "Retired scaffolding journal evidence");
    await this.#operations.faultInjector?.({
      evidence,
      mutation,
      phase: "before-logical-retirement"
    });
    await this.#prove(retired.path, expected, "Retired scaffolding journal evidence");
    const terminalRoot = join(
      this.#parent,
      `${FOUNDATION_TRANSACTION_FILE}.completed-scaffold-evidence`
    );
    await mkdir(terminalRoot, { mode: 0o700 }).catch((error) => {
      if (scaffoldJournalErrorCode(error) !== "EEXIST") {
        throw error;
      }
    });
    await this.#syncDirectory(this.#parent, mutation, "state-parent");
    const terminalDirectory = join(terminalRoot, basename(retired.directory));
    await rename(retired.directory, terminalDirectory);
    await this.#syncDirectory(terminalRoot, mutation, "destination");
    if (sourceDirectory !== this.#parent) {
      await rename(
        sourceDirectory,
        join(terminalRoot, `${basename(sourceDirectory)}.empty`)
      );
      await this.#syncDirectory(terminalRoot, mutation, "destination");
    }
    await this.#syncDirectory(
      this.#parent,
      mutation,
      "state-parent"
    );
  }

  async #syncDirectory(
    path: string,
    mutation: NodeScaffoldJournalMutation,
    role: "destination" | "source" | "state-parent"
  ): Promise<void> {
    await this.#operations.faultInjector?.({
      mutation,
      path,
      phase: "before-directory-sync",
      role
    });
    await this.#operations.syncDirectoryStrictly?.(path);
  }

  async #syncRenameBoundary(
    destination: string,
    source: string,
    mutation: NodeScaffoldJournalMutation
  ): Promise<void> {
    await this.#syncDirectory(destination, mutation, "destination");
    if (source !== destination) {
      await this.#syncDirectory(source, mutation, "source");
    }
    if (this.#parent !== destination && this.#parent !== source) {
      await this.#syncDirectory(this.#parent, mutation, "state-parent");
    }
  }
}
