import { lstat, opendir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";

import { sha256Json, type CanonicalJsonValue } from "../../../canonical-json.js";
import { RepositoryMutationError } from "../../application/errors.js";
import type { PortablePathIdentity } from "../../../path-identity.js";
import type { MutationLeasePort } from "../../application/ports/mutation-lease-port.js";
import { KNOWN_FILE_TRANSACTION_TEMPORARY_FILE, LOCAL_STATE_DIRECTORY,
  FOUNDATION_TRANSACTION_FILE, TRANSACTION_TEMPORARY_FILE } from "../../application/state-contract.js";
import { NodeMutationOperationLock } from "./node-operation-lock.js";

const commonEvidenceNames = Object.freeze([
  FOUNDATION_TRANSACTION_FILE,
  TRANSACTION_TEMPORARY_FILE,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE
]);
const maximumStateDirectoryEntries = 1024;

function portableStateName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function isSuspiciousCommonEvidenceName(name: string): boolean {
  const portable = portableStateName(name);
  const transaction = portableStateName(FOUNDATION_TRANSACTION_FILE);
  const terminalKnownFileEvidenceName =
    `${FOUNDATION_TRANSACTION_FILE}.completed-known-file-evidence`;
  const terminalKnownFileEvidence = portableStateName(terminalKnownFileEvidenceName);
  const terminalEvidence = new RegExp(
    `^${transaction.replaceAll(".", "\\.")}\\.completed-[a-z0-9-]+-evidence$`,
    "u"
  );
  return commonEvidenceNames.some((expected) =>
    portable === portableStateName(expected) && name !== expected) ||
    (portable.startsWith(`${transaction}.`) &&
      (portable !== terminalKnownFileEvidence || name !== terminalKnownFileEvidenceName) &&
      (!terminalEvidence.test(portable) || name !== portable) &&
      !commonEvidenceNames.includes(name as (typeof commonEvidenceNames)[number])) ||
    portable.includes("cleanup-residue");
}

async function boundedSuspiciousStateNames(directory: string): Promise<readonly string[]> {
  const handle = await opendir(directory);
  const suspicious: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = await handle.read();
      if (entry === null) {return suspicious.toSorted();}
      entries += 1;
      if (entries > maximumStateDirectoryEntries) {
        invalid(
          "MUTATION_CLAIM_INVALID",
          "Mutation state contains too many entries to classify common evidence safely."
        );
      }
      if (isSuspiciousCommonEvidenceName(entry.name)) {suspicious.push(entry.name);}
    }
  } finally {
    await handle.close();
  }
}

function invalid(code: "MUTATION_CLAIM_INVALID" | "MUTATION_LEASE_INVALID", message: string): never {
  throw new RepositoryMutationError(code, message);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function physicalRootIdentity(root: string): Promise<PortablePathIdentity> {
  const metadata = await lstat(root, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    invalid("MUTATION_LEASE_INVALID", "Mutation repository root is not one physical directory.");
  }
  return {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
}

async function boundedStateSnapshot(root: string): Promise<{
  readonly fingerprint: string;
  readonly commonEvidence: boolean;
}> {
  const directory = join(root, LOCAL_STATE_DIRECTORY);
  let directoryEntry;
  try {
    directoryEntry = await lstat(directory, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {return { fingerprint: "absent", commonEvidence: false };}
    throw error;
  }
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    return { fingerprint: "invalid-state-directory", commonEvidence: true };
  }

  const suspiciousNames = await boundedSuspiciousStateNames(directory);
  const observedNames = [...new Set([...commonEvidenceNames, ...suspiciousNames])].toSorted();
  const records: CanonicalJsonValue[] = [];
  for (const name of observedNames) {
    try {
      const entry = await lstat(join(directory, name), { bigint: true });
      records.push({
        name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        dev: entry.dev.toString(),
        ino: entry.ino.toString(),
        size: entry.size.toString(),
        mtimeNs: entry.mtimeNs.toString()
      });
    } catch (error) {
      if (!isMissing(error)) {throw error;}
    }
  }
  return {
    fingerprint: sha256Json({
      domain: "agent-teams.repository-mutation.observation/v1",
      directory: {
        dev: directoryEntry.dev.toString(),
        ino: directoryEntry.ino.toString(),
        mtimeNs: directoryEntry.mtimeNs.toString()
      },
      records
    }),
    commonEvidence: records.length > 0
  };
}

async function stateSnapshot(root: string): Promise<{
  readonly fingerprint: string;
  readonly commonEvidence: boolean;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await boundedStateSnapshot(root);
    const second = await boundedStateSnapshot(root);
    if (first.fingerprint === second.fingerprint &&
      first.commonEvidence === second.commonEvidence) {return second;}
  }
  invalid("MUTATION_CLAIM_INVALID", "Mutation state changed during bounded observation.");
}

export const nodeMutationLeasePort: MutationLeasePort = {
  canonicalRoot: (root) => realpath(resolve(root)),
  physicalRootIdentity,
  acquire: (root) => new NodeMutationOperationLock(root).acquire(),
  snapshot: stateSnapshot
};
