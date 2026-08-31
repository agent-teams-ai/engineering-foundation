import { lstat, opendir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";

import { sha256Json, type CanonicalJsonValue } from "../canonical-json.js";
import { RepositoryMutationError } from "../errors.js";
import {
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE,
  LOCAL_STATE_DIRECTORY,
  TRANSACTION_FILE,
  TRANSACTION_TEMPORARY_FILE
} from "../state-contract.js";
import { NodeMutationOperationLock } from "./adapters/node/node-operation-lock.js";

declare const leaseBrand: unique symbol;
declare const observationBrand: unique symbol;
declare const claimBrand: unique symbol;

export interface MutationLease { readonly [leaseBrand]: true }
export interface MutationObservation { readonly [observationBrand]: true }
export interface MutationClaim { readonly [claimBrand]: true }

export interface MutationArtifactIdentity {
  readonly name: string;
  readonly version: string;
  readonly buildIdentity: `sha256:${string}`;
}

export type MutationIntent =
  | {
      readonly kind: "apply-known-file";
      readonly planDigest: `sha256:${string}`;
      readonly ownerArtifact: MutationArtifactIdentity;
      readonly kernelArtifact: MutationArtifactIdentity;
    }
  | {
      readonly kind: "recover-known-file";
      readonly ownerArtifact: MutationArtifactIdentity;
      readonly kernelArtifact: MutationArtifactIdentity;
    };

interface LeaseState {
  readonly root: string;
  readonly release: (options?: { readonly retainTransactionBarrier?: boolean }) => Promise<void>;
  released: boolean;
  retained: boolean;
  sequence: number;
}
interface ObservationState {
  readonly lease: MutationLease;
  readonly fingerprint: string;
  readonly commonEvidence: boolean;
  readonly sequence: number;
}
interface ClaimState {
  readonly lease: MutationLease;
  readonly intent: MutationIntent;
  readonly fingerprint: string;
  readonly commonEvidence: boolean;
  readonly sequence: number;
  consumed: boolean;
}

const leases = new WeakMap<object, LeaseState>();
const observations = new WeakMap<object, ObservationState>();
const claims = new WeakMap<object, ClaimState>();
const commonEvidenceNames = Object.freeze([
  TRANSACTION_FILE,
  TRANSACTION_TEMPORARY_FILE,
  KNOWN_FILE_TRANSACTION_TEMPORARY_FILE
]);
const maximumStateDirectoryEntries = 1024;

function portableStateName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function isSuspiciousCommonEvidenceName(name: string): boolean {
  const portable = portableStateName(name);
  const transaction = portableStateName(TRANSACTION_FILE);
  const terminalEvidence = new RegExp(
    `^${transaction.replaceAll(".", "\\.")}\\.completed-[a-z0-9-]+-evidence$`,
    "u"
  );
  return commonEvidenceNames.some((expected) =>
    portable === portableStateName(expected) && name !== expected) ||
    (portable.startsWith(`${transaction}.`) &&
      !terminalEvidence.test(portable) &&
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

function leaseState(lease: MutationLease): LeaseState {
  const state = leases.get(lease as object);
  if (state === undefined || state.released) {invalid("MUTATION_LEASE_INVALID", "Mutation lease is forged, released, or unavailable.");}
  return state;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
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

function inertRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid("MUTATION_CLAIM_INVALID", `${label} is not inert record data.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.toSorted().join(",") !== keys.toSorted().join(",")) {
    invalid("MUTATION_CLAIM_INVALID", `${label} has an invalid shape.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid("MUTATION_CLAIM_INVALID", `${label} must contain only enumerable data properties.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function snapshotArtifact(value: unknown, label: string): MutationArtifactIdentity {
  const candidate = inertRecord(value, ["buildIdentity", "name", "version"], `${label} artifact identity`);
  if (typeof candidate["name"] !== "string" || candidate["name"].length === 0 ||
    typeof candidate["version"] !== "string" || candidate["version"].length === 0 ||
    typeof candidate["buildIdentity"] !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate["buildIdentity"])) {
    invalid("MUTATION_CLAIM_INVALID", `${label} artifact identity is invalid.`);
  }
  return Object.freeze({
    name: candidate["name"],
    version: candidate["version"],
    buildIdentity: candidate["buildIdentity"]
  }) as MutationArtifactIdentity;
}

function snapshotIntent(intent: MutationIntent): MutationIntent {
  if (typeof intent !== "object" || intent === null || Array.isArray(intent) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(intent))) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation intent is not inert record data.");
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(intent, "kind");
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation intent kind must be inert data.");
  }
  const candidate = inertRecord(
    intent,
    kindDescriptor.value === "apply-known-file"
      ? ["kernelArtifact", "kind", "ownerArtifact", "planDigest"]
      : ["kernelArtifact", "kind", "ownerArtifact"],
    "Mutation intent"
  );
  const ownerArtifact = snapshotArtifact(candidate["ownerArtifact"], "Owner");
  const kernelArtifact = snapshotArtifact(candidate["kernelArtifact"], "Kernel");
  if (candidate["kind"] === "apply-known-file" &&
    typeof candidate["planDigest"] === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(candidate["planDigest"])) {
    return Object.freeze({
      kind: "apply-known-file",
      planDigest: candidate["planDigest"],
      ownerArtifact,
      kernelArtifact
    }) as MutationIntent;
  }
  if (candidate["kind"] === "recover-known-file") {
    return Object.freeze({ kind: "recover-known-file", ownerArtifact, kernelArtifact });
  }
  invalid("MUTATION_CLAIM_INVALID", "Mutation intent is not one closed known-file intent.");
}

export async function acquireMutationLease(root: string): Promise<MutationLease> {
  const canonicalRoot = await realpath(resolve(root));
  const release = await new NodeMutationOperationLock(canonicalRoot).acquire();
  const lease = Object.freeze({}) as MutationLease;
  leases.set(lease as object, { root: canonicalRoot, release, released: false, retained: false, sequence: 0 });
  return lease;
}

export async function observeMutationState(lease: MutationLease): Promise<MutationObservation> {
  const state = leaseState(lease);
  const snapshot = await stateSnapshot(state.root);
  const observation = Object.freeze({}) as MutationObservation;
  observations.set(observation as object, {
    lease,
    fingerprint: snapshot.fingerprint,
    commonEvidence: snapshot.commonEvidence,
    sequence: state.sequence
  });
  return observation;
}

export async function claimMutation(
  lease: MutationLease,
  observation: MutationObservation,
  intent: MutationIntent
): Promise<MutationClaim> {
  const state = leaseState(lease);
  const observed = observations.get(observation as object);
  if (observed === undefined || observed.lease !== lease || observed.sequence !== state.sequence) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation observation is forged, stale, or belongs to another lease.");
  }
  const current = await stateSnapshot(state.root);
  if (observed.fingerprint !== current.fingerprint) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation observation became stale before the claim was issued.");
  }
  const capturedIntent = snapshotIntent(intent);
  if (capturedIntent.kind === "apply-known-file" && observed.commonEvidence) {
    invalid("MUTATION_CLAIM_INVALID", "Common transaction evidence must be recovered before apply.");
  }
  if (capturedIntent.kind === "recover-known-file" && !observed.commonEvidence) {
    invalid("MUTATION_CLAIM_INVALID", "Known-file recovery requires common transaction evidence.");
  }
  const claim = Object.freeze({}) as MutationClaim;
  state.sequence += 1;
  claims.set(claim as object, {
    lease,
    intent: capturedIntent,
    fingerprint: observed.fingerprint,
    commonEvidence: observed.commonEvidence,
    sequence: state.sequence,
    consumed: false
  });
  return claim;
}

export async function consumeMutationClaim(
  claim: MutationClaim,
  expectedKind: MutationIntent["kind"]
): Promise<string> {
  const claimState = claims.get(claim as object);
  if (claimState === undefined || claimState.consumed || claimState.intent.kind !== expectedKind) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation claim is forged, consumed, or has the wrong intent.");
  }
  const state = leaseState(claimState.lease);
  if (claimState.sequence !== state.sequence) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation claim generation became stale before consumption.");
  }
  const current = await stateSnapshot(state.root);
  if (current.fingerprint !== claimState.fingerprint ||
    current.commonEvidence !== claimState.commonEvidence) {
    if (current.commonEvidence) {state.retained = true;}
    invalid("MUTATION_CLAIM_INVALID", "Mutation claim evidence became stale before consumption.");
  }
  claimState.consumed = true;
  state.sequence += 1;
  return state.root;
}

export function mutationClaimIntent(claim: MutationClaim): MutationIntent {
  const claimState = claims.get(claim as object);
  if (claimState === undefined || claimState.consumed) {invalid("MUTATION_CLAIM_INVALID", "Mutation claim is forged or consumed.");}
  leaseState(claimState.lease);
  return claimState.intent;
}

export async function retainMutationClaimBarrierOnEvidence(claim: MutationClaim): Promise<void> {
  const claimState = claims.get(claim as object);
  if (claimState === undefined) {return;}
  const state = leaseState(claimState.lease);
  try {
    if ((await stateSnapshot(state.root)).commonEvidence) {state.retained = true;}
  } catch {
    state.retained = true;
  }
}

export async function retainMutationBarrierOnEvidence(lease: MutationLease): Promise<boolean> {
  const state = leaseState(lease);
  try {
    if (!(await stateSnapshot(state.root)).commonEvidence) {return false;}
  } catch {
    state.retained = true;
    return true;
  }
  state.retained = true;
  return true;
}

export function retainMutationBarrier(lease: MutationLease): void {
  leaseState(lease).retained = true;
}

export async function releaseMutationLease(lease: MutationLease): Promise<void> {
  const state = leaseState(lease);
  await state.release({ retainTransactionBarrier: state.retained });
  state.released = true;
}

export function mutationLeaseRoot(lease: MutationLease): string {
  return leaseState(lease).root;
}

export const COMMON_TRANSACTION_FILE = TRANSACTION_FILE;
