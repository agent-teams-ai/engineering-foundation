import type { InternalFoundationTransactionStatus } from "../model/internal-transaction-status.js";

export interface FoundationTransactionInspection {
  inspect(value: unknown): Promise<InternalFoundationTransactionStatus>;
}

export interface InstalledFoundationInspectionIdentity {
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
}

type RecordInspection = (value: Record<string, unknown>) => InternalFoundationTransactionStatus | Promise<InternalFoundationTransactionStatus>;
type InstalledOwnerInspection = (input: InstalledFoundationInspectionIdentity & {
  readonly value: Record<string, unknown>;
}) => Promise<InternalFoundationTransactionStatus>;

/** Fixed supported owners, wired by composition; no runtime registration. */
export interface FoundationTransactionInspectors {
  readonly legacyScaffoldingJournal: InstalledOwnerInspection;
  readonly legacyScaffoldingEnvelope: RecordInspection;
  readonly legacyDocument: RecordInspection;
  readonly document: RecordInspection;
  readonly knownFile: RecordInspection;
  readonly currentScaffolding: InstalledOwnerInspection;
  readonly schema6: RecordInspection;
}
