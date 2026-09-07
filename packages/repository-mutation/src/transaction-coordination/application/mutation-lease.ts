import { RepositoryMutationError } from "./errors.js";
import type { PortablePathIdentity } from "../../path-identity.js";
import type { MutationLeasePort } from "./ports/mutation-lease-port.js";

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
  readonly port: MutationLeasePort;
  readonly root: string;
  readonly rootIdentity: PortablePathIdentity;
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
function invalid(code: "MUTATION_CLAIM_INVALID" | "MUTATION_LEASE_INVALID", message: string): never {
  throw new RepositoryMutationError(code, message);
}

function leaseState(lease: MutationLease): LeaseState {
  const state = leases.get(lease);
  if (state === undefined || state.released) {invalid("MUTATION_LEASE_INVALID", "Mutation lease is forged, released, or unavailable.");}
  return state;
}

async function assertPhysicalRoot(state: LeaseState): Promise<void> {
  let current: PortablePathIdentity;
  try {
    current = await state.port.physicalRootIdentity(state.root);
  } catch (error) {
    if (error instanceof RepositoryMutationError) {throw error;}
    invalid("MUTATION_LEASE_INVALID", "Mutation repository root cannot be revalidated.");
  }
  if (current.birthtimeNs !== state.rootIdentity.birthtimeNs ||
    current.dev !== state.rootIdentity.dev || current.ino !== state.rootIdentity.ino) {
    state.retained = true;
    invalid("MUTATION_LEASE_INVALID", "Mutation repository root changed after the physical lease was acquired.");
  }
}

function hasPlainPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inertRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    !hasPlainPrototype(value)) {
    invalid("MUTATION_CLAIM_INVALID", `${label} is not inert record data.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every((key) => typeof key === "string") ||
    ownKeys.toSorted(binaryCompare).join(",") !== keys.toSorted(binaryCompare).join(",")) {
    invalid("MUTATION_CLAIM_INVALID", `${label} has an invalid shape.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
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

function snapshotIntent(intent: unknown): MutationIntent {
  if (typeof intent !== "object" || intent === null || Array.isArray(intent) ||
    !hasPlainPrototype(intent)) {
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

async function acquireMutationLease(root: string, port: MutationLeasePort): Promise<MutationLease> {
  const canonicalRoot = await port.canonicalRoot(root);
  const rootIdentity = await port.physicalRootIdentity(canonicalRoot);
  const release = await port.acquire(canonicalRoot);
  const currentIdentity = await port.physicalRootIdentity(canonicalRoot);
  if (currentIdentity.birthtimeNs !== rootIdentity.birthtimeNs ||
    currentIdentity.dev !== rootIdentity.dev || currentIdentity.ino !== rootIdentity.ino) {
    await release({ retainTransactionBarrier: true });
    invalid("MUTATION_LEASE_INVALID", "Mutation repository root changed while its physical lease was acquired.");
  }
  const lease = Object.freeze({}) as MutationLease;
  leases.set(lease, {
    port,
    root: canonicalRoot,
    rootIdentity,
    release,
    released: false,
    retained: false,
    sequence: 0
  });
  return lease;
}

export async function observeMutationState(lease: MutationLease): Promise<MutationObservation> {
  const state = leaseState(lease);
  await assertPhysicalRoot(state);
  const snapshot = await state.port.snapshot(state.root);
  const observation = Object.freeze({}) as MutationObservation;
  observations.set(observation, {
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
  await assertPhysicalRoot(state);
  const observed = observations.get(observation);
  if (observed === undefined || observed.lease !== lease || observed.sequence !== state.sequence) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation observation is forged, stale, or belongs to another lease.");
  }
  const current = await state.port.snapshot(state.root);
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
  claims.set(claim, {
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
  const claimState = claims.get(claim);
  if (claimState === undefined || claimState.consumed || claimState.intent.kind !== expectedKind) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation claim is forged, consumed, or has the wrong intent.");
  }
  const state = leaseState(claimState.lease);
  await assertPhysicalRoot(state);
  if (claimState.sequence !== state.sequence) {
    invalid("MUTATION_CLAIM_INVALID", "Mutation claim generation became stale before consumption.");
  }
  const current = await state.port.snapshot(state.root);
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
  const claimState = claims.get(claim);
  if (claimState === undefined || claimState.consumed) {invalid("MUTATION_CLAIM_INVALID", "Mutation claim is forged or consumed.");}
  leaseState(claimState.lease);
  return claimState.intent;
}

export async function retainMutationClaimBarrierOnEvidence(claim: MutationClaim): Promise<void> {
  const claimState = claims.get(claim);
  if (claimState === undefined) {return;}
  const state = leaseState(claimState.lease);
  try {
    if ((await state.port.snapshot(state.root)).commonEvidence) {state.retained = true;}
  } catch {
    state.retained = true;
  }
}

export async function retainMutationBarrierOnEvidence(lease: MutationLease): Promise<boolean> {
  const state = leaseState(lease);
  try {
    if (!(await state.port.snapshot(state.root)).commonEvidence) {return false;}
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

/** Each lease retains its selected port; alternative providers cannot replace it. */
export function createMutationLeaseOperations(port: MutationLeasePort): {
  readonly acquireMutationLease: (root: string) => Promise<MutationLease>;
} {
  return { acquireMutationLease: (root) => acquireMutationLease(root, port) };
}
