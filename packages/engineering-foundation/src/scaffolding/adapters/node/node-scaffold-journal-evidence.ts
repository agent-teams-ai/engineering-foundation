import type { ScaffoldTransactionArtifacts } from "../../application/ports/transaction-observation.js";
import { TextDecoder } from "node:util";

import type {
  JournalSlotAuthority,
  JournalSlotObservation,
  StoredJournalSlot
} from "@agent-teams/repository-mutation/node";
import { FOUNDATION_TRANSACTION_FILE } from "../../application/policies/transaction-identity.js";
import type {
  AuthorityScaffoldJournal
} from "../../contract/types.js";
import type {
  JsonValue
} from "../../application/model/scaffold-values.js";
import { assertAuthorityScaffoldJournal } from "../inbound/assert-authority-scaffold-journal.js";
import { canonicalJson } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import type { ScaffoldSchemaValidator } from "../schema-validation.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import {
  compileFoundationScaffoldEnvelope,
  parseFoundationScaffoldEnvelope
} from "./foundation-scaffold-envelope.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export const SCAFFOLD_JOURNAL_FILE = FOUNDATION_TRANSACTION_FILE;
/**
 * Historical quarantine prefix written by the retired pretty-printed journal
 * writer. Recovery still recognises it as transaction residue.
 */
export const SCAFFOLD_JOURNAL_QUARANTINE_PREFIX =
  `${FOUNDATION_TRANSACTION_FILE}.document-quarantine.`;
export const scaffoldQuarantinePrefix =
  `${FOUNDATION_TRANSACTION_FILE}.scaffold-quarantine.`;
export const scaffoldRetiredPrefix =
  `${FOUNDATION_TRANSACTION_FILE}.scaffold-retired.`;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ScaffoldJournalAuthority = JournalSlotAuthority;

export type StoredScaffoldJournal = StoredJournalSlot<AuthorityScaffoldJournal>;

export type ScaffoldJournalSlotObservation =
  JournalSlotObservation<AuthorityScaffoldJournal>;

export function scaffoldJournalRecoveryRequired(
  message: string,
  cause?: unknown
): ScaffoldError {
  return new ScaffoldError(
    "SCAFFOLD_RECOVERY_REQUIRED",
    message,
    [],
    cause === undefined ? undefined : { cause }
  );
}

export async function serializeScaffoldJournal(
  journal: AuthorityScaffoldJournal,
  assertSchema: ScaffoldSchemaValidator,
  observeArtifacts: ScaffoldTransactionArtifacts
): Promise<Buffer> {
  try {
    await assertSchema(
      "scaffold-recovery-journal/v1",
      journal,
      "scaffold-recovery-journal"
    );
    await assertSchema(
      "scaffold-plan/v1",
      journal.plan,
      "scaffold-recovery-journal"
    );
    assertAuthorityScaffoldJournal(journal);
  } catch (error) {
    throw scaffoldJournalRecoveryRequired(
      "Scaffolding journal does not satisfy the released contract.",
      error
    );
  }
  const envelope = await compileFoundationScaffoldEnvelope(journal, observeArtifacts);
  const bytes = Buffer.from(
    `${canonicalJson(envelope as unknown as JsonValue)}\n`,
    "utf8"
  );
  if (bytes.byteLength > MAX_SCAFFOLD_PLAN_BYTES) {
    throw scaffoldJournalRecoveryRequired(
      "Scaffolding journal exceeds its bounded size limit."
    );
  }
  return bytes;
}

function isSchema6Envelope(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    Reflect.get(value, "schemaVersion") === 6;
}

/**
 * Parses stable canonical journal bytes. The closed schema6 Foundation
 * envelope is current; the historical pretty-printed v1 journal remains
 * readable so an interrupted transaction from an older release stays
 * recoverable evidence rather than an opaque file.
 */
export async function parseScaffoldJournal(
  bytes: Buffer,
  assertSchema: ScaffoldSchemaValidator,
  observeArtifacts: ScaffoldTransactionArtifacts
): Promise<AuthorityScaffoldJournal> {
  let journal: AuthorityScaffoldJournal;
  let schema6 = false;
  try {
    const value = parseStrictJson(strictUtf8.decode(bytes));
    schema6 = isSchema6Envelope(value);
    if (schema6) {
      ({ journal } = await parseFoundationScaffoldEnvelope(bytes, observeArtifacts));
    } else {
      await assertSchema(
        "scaffold-recovery-journal/v1",
        value,
        "scaffold-recovery-journal"
      );
      journal = value as AuthorityScaffoldJournal;
      await assertSchema(
        "scaffold-plan/v1",
        journal.plan,
        "scaffold-recovery-journal"
      );
      assertAuthorityScaffoldJournal(journal);
    }
  } catch (error) {
    throw scaffoldJournalRecoveryRequired(
      "Scaffolding journal contains invalid strict JSON or contract data.",
      error
    );
  }
  const expectedBytes = schema6
    ? await serializeScaffoldJournal(journal, assertSchema, observeArtifacts)
    : Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
  if (!bytes.equals(expectedBytes)) {
    throw scaffoldJournalRecoveryRequired(
      "Scaffolding journal bytes are not in the historical canonical form."
    );
  }
  return journal;
}
