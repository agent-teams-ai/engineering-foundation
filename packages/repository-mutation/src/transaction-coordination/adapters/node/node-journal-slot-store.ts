import { link, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  createPrivateJournalSlotDirectory,
  journalSlotPathExists,
  journalSlotResidueNames,
  observeJournalSlotAuthority,
  prepareJournalSlotCandidate,
  readJournalSlot
} from "./node-journal-slot-evidence.js";
import {
  classifyCleanJournalSlotMutation,
  sameJournalSlotAuthority,
  type JournalSlotAuthority,
  type JournalSlotEvidence,
  type JournalSlotFaultPoint,
  type JournalSlotMutation,
  type JournalSlotObservation,
  type JournalSlotProfile,
  type JournalSlotSubject,
  type JournalSlotSyncRole,
  type JournalSlotSyncStage,
  type PendingJournalSlotMutation,
  type StoredJournalSlot
} from "./node-journal-slot-profile.js";
import {
  assertTerminalEvidenceDirectory,
  ensureTerminalEvidenceDirectory
} from "../../../repository-mutation/adapters/node/node-terminal-evidence-directory.js";

interface PrivateEvidence {
  readonly authority: JournalSlotAuthority;
  readonly directory: string;
  readonly path: string;
}

interface RetirementRequest {
  readonly authority: JournalSlotAuthority;
  readonly evidence: JournalSlotEvidence;
  readonly mutation: JournalSlotMutation;
  readonly path: string;
  readonly sourceDirectory: string;
}

/**
 * Crash-safe canonical journal slot shared by independent transaction
 * owners. Each mutation publishes a fresh hard-linked candidate, quarantines
 * the previous content under a private directory, retires owned evidence into
 * a terminal directory, and re-proves every authority before the next
 * irreversible step. The on-disk sequence is identical for every owner; only
 * naming, serialization, diagnostics, and observability come from the profile.
 *
 * Two fault points bracket each private directory creation (quarantine and
 * retirement) so an owner can keep its released crash characterization: one
 * fires before the directory exists, the other after it exists but before the
 * evidence pathname moves.
 */
export class NodeJournalSlotStore<TJournal> {
  readonly #parent: string;
  readonly #profile: JournalSlotProfile<TJournal>;
  #pending: PendingJournalSlotMutation | undefined;

  public constructor(profile: JournalSlotProfile<TJournal>) {
    this.#profile = profile;
    this.#parent = dirname(profile.canonicalPath);
  }

  public get canonicalPath(): string {
    return this.#profile.canonicalPath;
  }

  public async read(): Promise<StoredJournalSlot<TJournal> | undefined> {
    this.#assertStabilized("read");
    await this.#assertNoResidue("read");
    return this.#readCanonical();
  }

  public async stabilizeForReconciliation(): Promise<JournalSlotObservation<TJournal>> {
    await this.#fault({ phase: "before-reconciliation-directory-sync" });
    await this.#profile.syncDirectory(this.#parent);
    const residueNames = await this.#residueNames();
    if (this.#profile.reconciliation === "residue-only") {
      if (residueNames.length !== 0) {
        return { outcome: "recovery-required", residueNames };
      }
      const stored = await this.#readCanonical();
      return { outcome: "stable", ...(stored === undefined ? {} : { stored }) };
    }
    const canonical = await this.#readCanonical();
    if (residueNames.length !== 0) {
      return {
        ...(canonical === undefined ? {} : { canonical }),
        outcome: "recovery-required",
        residueNames
      };
    }
    const pending = this.#pending;
    if (pending === undefined) {
      return { outcome: "stable", ...(canonical === undefined ? {} : { stored: canonical }) };
    }
    const outcome = classifyCleanJournalSlotMutation(pending, canonical?.authority);
    if (outcome === "recovery-required") {
      return { ...(canonical === undefined ? {} : { canonical }), outcome, residueNames: [] };
    }
    this.#pending = undefined;
    return { outcome, ...(canonical === undefined ? {} : { stored: canonical }) };
  }

  public create(journal: TJournal): Promise<JournalSlotAuthority> {
    return this.#mutate("create", undefined, journal);
  }

  public replace(
    expected: JournalSlotAuthority,
    journal: TJournal
  ): Promise<JournalSlotAuthority> {
    return this.#mutate("replace", expected, journal);
  }

  public async remove(expected: JournalSlotAuthority): Promise<void> {
    this.#assertStabilized("remove");
    await this.#assertNoResidue("remove");
    await this.#requireCanonical(expected);
    this.#beginPending({ kind: "remove", prior: expected });
    const previous = await this.#quarantineCanonical(expected, "remove");
    await this.#retire({
      authority: previous.authority,
      evidence: "previous",
      mutation: "remove",
      path: previous.path,
      sourceDirectory: previous.directory
    });
    await this.#finishRemoval();
    this.#endPending();
  }

  async #mutate(
    mutation: "create" | "replace",
    expected: JournalSlotAuthority | undefined,
    journal: TJournal
  ): Promise<JournalSlotAuthority> {
    this.#assertStabilized(mutation);
    await this.#assertNoResidue(mutation);
    const bytes = await this.#profile.codec.serialize(journal);
    if (expected === undefined) {
      if (await this.#occupied()) {
        throw this.#profile.failure("slot-occupied", { mutation });
      }
      this.#beginPending({ kind: "create" });
    } else {
      await this.#requireCanonical(expected);
      this.#beginPending({ kind: "replace", prior: expected });
    }
    const candidate = await this.#prepareCandidate(bytes, mutation);
    if (this.#pending !== undefined && this.#pending.kind !== "remove") {
      this.#pending.intendedAuthority = candidate;
    }
    const previous = expected === undefined
      ? undefined
      : await this.#quarantineCanonical(expected, "replace");
    await this.#publishCandidate(candidate, mutation);
    await this.#retire({
      authority: candidate,
      evidence: "candidate",
      mutation,
      path: this.#profile.naming.candidatePath,
      sourceDirectory: this.#parent
    });
    if (previous !== undefined) {
      await this.#retire({
        authority: previous.authority,
        evidence: "previous",
        mutation,
        path: previous.path,
        sourceDirectory: previous.directory
      });
    }
    await this.#finishPublication(candidate, mutation);
    this.#endPending();
    return candidate;
  }

  async #prepareCandidate(
    bytes: Buffer,
    mutation: "create" | "replace"
  ): Promise<JournalSlotAuthority> {
    const { candidatePath } = this.#profile.naming;
    const candidate = await prepareJournalSlotCandidate({
      bytes,
      candidatePath,
      failure: this.#profile.failure
    });
    await this.#prove(candidatePath, candidate, "candidate");
    await this.#syncDirectory(this.#parent, mutation, "state-parent", "candidate");
    await this.#fault({ mutation, phase: "after-candidate-synced" });
    await this.#prove(candidatePath, candidate, "candidate");
    return candidate;
  }

  async #quarantineCanonical(
    expected: JournalSlotAuthority,
    mutation: "remove" | "replace"
  ): Promise<PrivateEvidence> {
    await this.#prove(this.canonicalPath, expected, "canonical");
    await this.#fault({ mutation, path: this.canonicalPath, phase: "before-quarantine-directory" });
    await this.#prove(this.canonicalPath, expected, "canonical");
    const quarantine = await createPrivateJournalSlotDirectory(
      this.#parent,
      () => this.#profile.naming.quarantineDirectoryName(expected)
    );
    await this.#fault({ mutation, path: this.canonicalPath, phase: "before-shared-quarantine" });
    await this.#prove(this.canonicalPath, expected, "canonical");
    try {
      await rename(this.canonicalPath, quarantine.path);
    } catch (error) {
      throw this.#profile.failure("quarantine-unavailable", { cause: error, mutation });
    }
    await this.#syncRenameBoundary(quarantine.directory, this.#parent, mutation);
    await this.#prove(quarantine.path, expected, "quarantine");
    await this.#fault({ mutation, phase: "after-shared-quarantine-synced" });
    return { ...quarantine, authority: expected };
  }

  async #publishCandidate(
    candidate: JournalSlotAuthority,
    mutation: "create" | "replace"
  ): Promise<void> {
    const { candidatePath } = this.#profile.naming;
    await this.#fault({ mutation, phase: "before-canonical-link" });
    await this.#prove(candidatePath, candidate, "candidate");
    try {
      await link(candidatePath, this.canonicalPath);
    } catch (error) {
      throw this.#profile.failure("publication-conflict", { cause: error, mutation });
    }
    await this.#prove(this.canonicalPath, candidate, mutation === "replace" ? "replacement" : "canonical");
    await this.#fault({ mutation, phase: "after-canonical-linked" });
    await this.#syncDirectory(this.#parent, mutation, "state-parent", "publication");
    await this.#fault({ mutation, phase: "after-canonical-synced" });
  }

  async #retire(request: RetirementRequest): Promise<void> {
    const { authority, evidence, mutation, path, sourceDirectory } = request;
    await this.#prove(path, authority, "evidence", evidence);
    await this.#fault({ evidence, mutation, path, phase: "before-retirement-directory" });
    await this.#prove(path, authority, "evidence", evidence);
    const retired = await createPrivateJournalSlotDirectory(
      this.#parent,
      this.#profile.naming.retiredDirectoryName
    );
    await this.#fault({ evidence, mutation, path, phase: "before-private-retirement" });
    await this.#fault({ evidence, mutation, path, phase: "before-private-retirement-rename" });
    await this.#prove(path, authority, "evidence", evidence);
    await rename(path, retired.path);
    await this.#syncRenameBoundary(retired.directory, sourceDirectory, mutation);
    await this.#prove(retired.path, authority, "retired-evidence", evidence);
    await this.#fault({ evidence, mutation, path: retired.path, phase: "before-logical-retirement" });
    await this.#prove(retired.path, authority, "retired-evidence", evidence);
    const terminalRoot = join(this.#parent, this.#profile.naming.terminalRootName);
    const terminalAuthority = await ensureTerminalEvidenceDirectory(terminalRoot);
    await this.#syncDirectory(this.#parent, mutation, "state-parent", "transition");
    await assertTerminalEvidenceDirectory(terminalAuthority);
    await rename(retired.directory, join(terminalRoot, basename(retired.directory)));
    await this.#syncDirectory(terminalRoot, mutation, "destination", "transition");
    if (sourceDirectory !== this.#parent) {
      await assertTerminalEvidenceDirectory(terminalAuthority);
      await rename(sourceDirectory, join(terminalRoot, `${basename(sourceDirectory)}.empty`));
      await this.#syncDirectory(terminalRoot, mutation, "destination", "transition");
    }
    await this.#syncDirectory(this.#parent, mutation, "state-parent", "transition");
  }

  async #finishPublication(
    candidate: JournalSlotAuthority,
    mutation: "create" | "replace"
  ): Promise<void> {
    const subject = mutation === "replace" ? "replacement" : "canonical";
    await this.#prove(this.canonicalPath, candidate, subject);
    await this.#fault({ mutation, phase: "before-final-directory-sync" });
    await this.#prove(this.canonicalPath, candidate, subject);
    await this.#syncDirectory(this.#parent, mutation, "state-parent", "final");
    await this.#prove(this.canonicalPath, candidate, subject);
    await this.#fault({ mutation, phase: "after-final-directory-sync" });
  }

  async #finishRemoval(): Promise<void> {
    await this.#proveMissing();
    await this.#fault({ mutation: "remove", phase: "before-final-directory-sync" });
    await this.#proveMissing();
    await this.#syncDirectory(this.#parent, "remove", "state-parent", "final");
    await this.#proveMissing();
    await this.#fault({ mutation: "remove", phase: "after-final-directory-sync" });
  }

  #assertStabilized(mutation: JournalSlotMutation | "read"): void {
    if (this.#profile.reconciliation === "sticky-pending" && this.#pending !== undefined) {
      throw this.#profile.failure("must-be-stabilized", { mutation });
    }
  }

  async #assertNoResidue(mutation: JournalSlotMutation | "read"): Promise<void> {
    if ((await this.#residueNames()).length !== 0) {
      throw this.#profile.failure("transition-residue", { mutation });
    }
  }

  #residueNames(): Promise<readonly string[]> {
    return journalSlotResidueNames({
      failure: this.#profile.failure,
      matchers: this.#profile.naming.residues,
      parent: this.#parent
    });
  }

  #readCanonical(): Promise<StoredJournalSlot<TJournal> | undefined> {
    return readJournalSlot({
      failure: this.#profile.failure,
      maximumBytes: this.#profile.maximumBytes,
      parse: this.#profile.codec.parse,
      path: this.canonicalPath
    });
  }

  async #occupied(): Promise<boolean> {
    return this.#profile.canonicalInspection === "authority"
      ? journalSlotPathExists(this.canonicalPath, this.#profile.maximumBytes)
      : (await this.#readCanonical()) !== undefined;
  }

  async #requireCanonical(expected: JournalSlotAuthority): Promise<void> {
    if (this.#profile.canonicalInspection === "authority") {
      await this.#prove(this.canonicalPath, expected, "canonical");
      return;
    }
    const stored = await this.#readCanonical();
    if (stored === undefined || !sameJournalSlotAuthority(stored.authority, expected)) {
      throw this.#profile.failure("changed", { subject: "canonical" });
    }
  }

  #beginPending(pending: PendingJournalSlotMutation): void {
    if (this.#profile.reconciliation === "sticky-pending") {
      this.#pending = pending;
    }
  }

  #endPending(): void {
    this.#pending = undefined;
  }

  async #prove(
    path: string,
    expected: JournalSlotAuthority,
    subject: JournalSlotSubject,
    evidence?: JournalSlotEvidence
  ): Promise<void> {
    const observed = await observeJournalSlotAuthority(path, expected, this.#profile.maximumBytes);
    if (observed !== "match") {
      throw this.#profile.failure("changed", {
        ...(evidence === undefined ? {} : { evidence }),
        subject
      });
    }
  }

  async #proveMissing(): Promise<void> {
    const present = this.#profile.canonicalInspection === "authority"
      ? await journalSlotPathExists(this.canonicalPath, this.#profile.maximumBytes)
      : (await this.#readCanonical()) !== undefined;
    if (present) {
      throw this.#profile.failure("canonical-recreated", { subject: "canonical" });
    }
  }

  async #syncDirectory(
    path: string,
    mutation: JournalSlotMutation,
    role: JournalSlotSyncRole,
    stage: JournalSlotSyncStage
  ): Promise<void> {
    if (this.#profile.observableSyncStages.includes(stage)) {
      await this.#fault({ mutation, path, phase: "before-directory-sync", role, stage });
    }
    await this.#profile.syncDirectory(path);
  }

  async #syncRenameBoundary(
    destination: string,
    source: string,
    mutation: JournalSlotMutation
  ): Promise<void> {
    await this.#syncDirectory(destination, mutation, "destination", "transition");
    if (source !== destination) {
      await this.#syncDirectory(source, mutation, "source", "transition");
    }
    if (this.#parent !== destination && this.#parent !== source) {
      await this.#syncDirectory(this.#parent, mutation, "state-parent", "transition");
    }
  }

  async #fault(point: JournalSlotFaultPoint): Promise<void> {
    await this.#profile.faultInjector?.(point);
  }
}
