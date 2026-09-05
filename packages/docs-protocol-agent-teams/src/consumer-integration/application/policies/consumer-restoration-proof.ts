import {
  assertKnownFileTransactionPlan, canonicalJson, compileKnownFileTransactionPlan,
  parseStrictJson, sha256Bytes, sha256Json,
  type CanonicalJsonValue, type KnownFileTransactionPlanV1,
  type KnownFileTransactionReceiptV1
} from "@agent-teams/repository-mutation";
import type { ConsumerRestorationIntent, ConsumerRestorationPreparation, ConsumerRestorationProof } from "../model/consumer-restoration.js";
import {
  assertQualifiedDocsCohortBindingV1, assertQualifiedDocsCohortBindingV2
} from "./consumer-integration-desired-state.js";

export const MAXIMUM_RESTORATION_PROOF_BYTES = 24 * 1024 * 1024;
export const restorationJson = (value: unknown): string => canonicalJson(value as CanonicalJsonValue);

export function requireRestoration(condition: unknown, message: string): asserts condition {
  if (condition !== true) {throw new TypeError(`Managed restoration: ${message}`);}
}

export function exactRestorationKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireRestoration(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0"), "invalid closed record.");
  return value as Record<string, unknown>;
}

export function assertFullyReplacedReceipt(
  plan: KnownFileTransactionPlanV1, receipt: KnownFileTransactionReceiptV1
): void {
  const body = {
    schemaVersion: 1,
    protocol: plan.protocol,
    planDigest: plan.planDigest,
    outcome: "applied",
    operations: plan.operations.map(({ path, postimage }) => ({
      path, outcome: "replaced", resultDigest: postimage.digest
    }))
  };
  const expected = { ...body, receiptDigest: sha256Json({
    domain: "agent-teams.repository-mutation.known-file-receipt/v1", body
  }) };
  requireRestoration(restorationJson(expected) === restorationJson(receipt),
    "receipt must bind every exact replacement and its result digest.");
}

export function inverseRestorationPlan(plan: KnownFileTransactionPlanV1): KnownFileTransactionPlanV1 {
  assertKnownFileTransactionPlan(plan);
  requireRestoration(plan.operations.length > 0 && plan.operations.length <= 8,
    "the original replacement set must be nonempty and bounded.");
  return compileKnownFileTransactionPlan({ operations: plan.operations.map((operation) => {
    requireRestoration(operation.precondition.state === "known-file" &&
      operation.precondition.acceptedPreimages.length === 1,
    "only one recorded preimage per replacement is supported.");
    const preimage = operation.precondition.acceptedPreimages[0]!;
    requireRestoration(preimage.digest !== operation.postimage.digest,
      "unchanged or ambiguously owned replacements are forbidden.");
    return {
      path: operation.path,
      precondition: { state: "known-file", acceptedPreimages: [{
        bytes: Buffer.from(operation.postimage.contentBase64, "base64"), mode: operation.postimage.mode
      }] },
      postimage: { bytes: Buffer.from(preimage.contentBase64, "base64"), mode: preimage.mode }
    };
  }) });
}

function assertRestorationArtifactShapes(proof: ConsumerRestorationIntent): void {
  for (const [artifact, name] of [
    [proof.controller, "@agent-teams/docs-protocol-agent-teams"],
    [proof.kernel, "@agent-teams/repository-mutation"]
  ] as const) {
    exactRestorationKeys(artifact, ["name", "version", "buildIdentity"]);
    requireRestoration(artifact.name === name && typeof artifact.version === "string" && typeof artifact.buildIdentity === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(artifact.version) &&
      /^sha256:[0-9a-f]{64}$/u.test(artifact.buildIdentity), "invalid artifact identity.");
  }
}

function assertRestorationIdentities(proof: ConsumerRestorationIntent): void {
  exactRestorationKeys(proof.consumer, ["root", "device", "inode", "birthtimeNs", "repository"]);
  const repository = exactRestorationKeys(proof.consumer.repository, ["provider", "id", "nameWithOwner"]);
  requireRestoration(typeof proof.consumer.root === "string" && proof.consumer.root.length <= 4096 &&
    !proof.consumer.root.includes("\0") &&
    [proof.consumer.device, proof.consumer.inode, proof.consumer.birthtimeNs].every((value) => typeof value === "string" && /^[0-9]+$/u.test(value)) && repository["provider"] === "github" && typeof proof.consumer.repository.id === "string" && typeof proof.consumer.repository.nameWithOwner === "string" &&
    /^[1-9][0-9]*$/u.test(proof.consumer.repository.id) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(proof.consumer.repository.nameWithOwner),
  "invalid consumer identity.");
  requireRestoration(typeof proof.sourceRevision === "string" && typeof proof.sourceTree === "string" && typeof proof.sourceInventoryDigest === "string" && /^(?!0{40}$)[0-9a-f]{40}$/u.test(proof.sourceRevision) &&
    /^(?!0{40}$)[0-9a-f]{40}$/u.test(proof.sourceTree) &&
    /^sha256:[0-9a-f]{64}$/u.test(proof.sourceInventoryDigest), "invalid source Git/inventory identity.");
  assertRestorationArtifactShapes(proof);
}

const intentKeys = [
  "schemaVersion", "protocol", "sourceGeneration", "targetGeneration", "consumer",
  "sourceRevision", "sourceTree", "sourceInventoryDigest", "sourceCohort", "targetCohort",
  "controller", "kernel", "plan", "initialProofPath"
];

function parseSelected(bytes: Uint8Array, expect: string, final: boolean): ConsumerRestorationPreparation | ConsumerRestorationProof {
  requireRestoration(bytes.byteLength > 0 && bytes.byteLength <= MAXIMUM_RESTORATION_PROOF_BYTES &&
    /^sha256:[0-9a-f]{64}$/u.test(expect) && sha256Bytes(bytes) === expect,
  "proof bytes differ from the separately retained selection digest.");
  const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const wire = exactRestorationKeys(parsed, final ? [...intentKeys, "receipt", "originalReceipt", "activation", "preparationDigest", "proofPath"] : intentKeys);
  requireRestoration(wire["schemaVersion"] === 1 && wire["sourceGeneration"] === 1 && wire["targetGeneration"] === 2 &&
    wire["protocol"] === (final ? "agent-teams.managed-v1-restoration/v1" : "agent-teams.managed-v1-restoration-preparation/v1"),
  "unsupported evidence generation.");
  const proof = parsed as ConsumerRestorationPreparation | ConsumerRestorationProof;
  assertRestorationIdentities(proof);
  assertQualifiedDocsCohortBindingV1(proof.sourceCohort);
  assertQualifiedDocsCohortBindingV2(proof.targetCohort);
  inverseRestorationPlan(proof.plan);
  requireRestoration(typeof proof.initialProofPath === "string" && proof.initialProofPath.startsWith("/") &&
    proof.initialProofPath.length <= 4096, "invalid initial proof destination.");
  requireRestoration(`${restorationJson(proof)}\n` === Buffer.from(bytes).toString("utf8"),
    "proof must be canonical, duplicate-free inert JSON.");
  return proof;
}

export function assertObservedRestorationReceipt(plan: KnownFileTransactionPlanV1, receipt: KnownFileTransactionReceiptV1): void {
  requireRestoration(receipt !== null && typeof receipt === "object" && Array.isArray(receipt.operations) &&
    receipt.operations.length === plan.operations.length, "receipt must classify every selected operation.");
  const operations = plan.operations.map(({ path, postimage }, index) => {
    const observed = receipt.operations[index];
    requireRestoration(observed?.outcome === "replaced" || observed?.outcome === "already-satisfied", "invalid observed receipt outcome.");
    return { path, outcome: observed.outcome, resultDigest: postimage.digest };
  });
  const body = { schemaVersion: 1, protocol: plan.protocol, planDigest: plan.planDigest,
    outcome: operations.some(({ outcome }) => outcome === "replaced") ? "applied" : "already-satisfied", operations };
  const expected = { ...body, receiptDigest: sha256Json({ domain: "agent-teams.repository-mutation.known-file-receipt/v1", body }) };
  requireRestoration(restorationJson(receipt) === restorationJson(expected), "receipt does not bind the honest selected operation outcomes.");
}

export function parseConsumerRestorationPreparation(bytes: Uint8Array, expect: string): ConsumerRestorationPreparation {
  return parseSelected(bytes, expect, false) as ConsumerRestorationPreparation;
}

export function parseConsumerRestorationProof(bytes: Uint8Array, expect: string): ConsumerRestorationProof {
  const proof = parseSelected(bytes, expect, true) as ConsumerRestorationProof;
  requireRestoration(proof.activation === "verified-current-v2" && /^sha256:[0-9a-f]{64}$/u.test(proof.preparationDigest) &&
    typeof proof.proofPath === "string" && proof.proofPath.startsWith("/") && proof.proofPath.length <= 4096,
  "unsupported final activation or selection evidence.");
  assertObservedRestorationReceipt(proof.plan, proof.receipt);
  if (proof.originalReceipt !== null) {assertFullyReplacedReceipt(proof.plan, proof.originalReceipt);}
  const { receipt: _receipt, originalReceipt: _original, activation: _activation, preparationDigest, proofPath: _path, ...intent } = proof;
  const preparation = { ...intent, protocol: "agent-teams.managed-v1-restoration-preparation/v1" };
  parseConsumerRestorationPreparation(Buffer.from(`${restorationJson(preparation)}\n`), preparationDigest);
  return proof;
}
