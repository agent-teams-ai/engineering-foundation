import {
  assertKnownFileTransactionPlan, canonicalJson, compileKnownFileTransactionPlan,
  parseStrictJson, sha256Bytes, sha256Json,
  type CanonicalJsonValue, type KnownFileTransactionPlanV1,
  type KnownFileTransactionReceiptV1
} from "@agent-teams/repository-mutation";
import type { ConsumerRestorationProof } from "../model/consumer-restoration.js";
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

function assertRestorationArtifactShapes(proof: ConsumerRestorationProof): void {
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

function assertRestorationIdentities(proof: ConsumerRestorationProof): void {
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

export function parseConsumerRestorationProof(bytes: Uint8Array, expect: string): ConsumerRestorationProof {
  requireRestoration(bytes.byteLength > 0 && bytes.byteLength <= MAXIMUM_RESTORATION_PROOF_BYTES &&
    /^sha256:[0-9a-f]{64}$/u.test(expect) && sha256Bytes(bytes) === expect,
  "proof bytes differ from the separately retained successful-upgrade digest.");
  const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const wire = exactRestorationKeys(parsed, [
    "schemaVersion", "protocol", "sourceGeneration", "targetGeneration", "consumer",
    "sourceRevision", "sourceTree", "sourceInventoryDigest", "sourceCohort", "targetCohort",
    "controller", "kernel", "plan", "receipt", "activation"
  ]);
  const proof = parsed as ConsumerRestorationProof;
  requireRestoration(wire["schemaVersion"] === 1 && wire["protocol"] === "agent-teams.managed-v1-restoration/v1" &&
    wire["sourceGeneration"] === 1 && wire["targetGeneration"] === 2 && wire["activation"] === "verified-current-v2",
  "unsupported proof generation or activation evidence.");
  assertRestorationIdentities(proof);
  assertQualifiedDocsCohortBindingV1(proof.sourceCohort);
  assertQualifiedDocsCohortBindingV2(proof.targetCohort);
  inverseRestorationPlan(proof.plan);
  assertFullyReplacedReceipt(proof.plan, proof.receipt);
  requireRestoration(`${restorationJson(proof)}\n` === Buffer.from(bytes).toString("utf8"),
    "proof must be canonical, duplicate-free inert JSON.");
  return proof;
}
