import { resolve } from "node:path";

import { assertBufQualificationActive, rejectBufQualificationInput } from "../../../application/policies/buf-qualification-input.js";
import type { BufQualificationObservation } from "../../../application/ports/buf-qualification-observation.js";
import { rejectQualificationFileFailure } from "../../../application/policies/qualification-file-failure.js";
import type { ProtobufSchemaAssertion } from "../../schema-validation.js";
import {
  assertExactBufFilePolicy,
  BUF_FILE_BREAKING_CONFIG_SOURCE,
  canonicalBufFindingSet,
  canonicalBufQualificationEvidence,
  canonicalBufQualificationInvocation,
  mapBufBreakingQualificationEvidence,
  qualificationInvocationInput
} from "../../../application/model/buf-breaking-qualification.js";
import type { BufBreakingQualificationEvidence } from "../../../application/model/protobuf-release-evidence.js";
import type {
  BufBreakingQualificationEvidencePort,
  ReadBufBreakingQualificationEvidenceInput,
  ResolvedBufBreakingQualificationEvidence
} from "../../../application/ports/buf-breaking-qualification-evidence.js";
import type { Sha256DigestPort } from "../../../application/ports/sha256-digest.js";
import { NodeSha256Digest } from "../crypto/node-sha256-digest.js";

const MAX_BUF_CONFIG_BYTES = 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

async function readQualificationFile(observation: BufQualificationObservation, input: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly label: string;
}): Promise<Buffer> {
  try {
    const source = await observation.read({
      candidate: resolve(input.consumerRoot, input.path),
      maxBytes: input.maxBytes,
      root: input.consumerRoot
    });
    return Buffer.isBuffer(source) ? source : Buffer.from(source);
  } catch (error) {
    rejectQualificationFileFailure(error, input);
  }
}

function withoutEvidenceDigest(
  evidence: BufBreakingQualificationEvidence
): Omit<BufBreakingQualificationEvidence, "evidenceDigest"> {
  return {
    schemaVersion: evidence.schemaVersion,
    producerId: evidence.producerId,
    producerVersion: evidence.producerVersion,
    policy: evidence.policy,
    contractId: evidence.contractId,
    bufVersion: evidence.bufVersion,
    modulePath: evidence.modulePath,
    bufConfigPath: evidence.bufConfigPath,
    evidencePath: evidence.evidencePath,
    bufConfigDigest: evidence.bufConfigDigest,
    baselineDescriptorImagePath: evidence.baselineDescriptorImagePath,
    baselineDescriptorImageDigest: evidence.baselineDescriptorImageDigest,
    candidateDescriptorImageDigest: evidence.candidateDescriptorImageDigest,
    breakingPolicyConfigDigest: evidence.breakingPolicyConfigDigest,
    invocationDigest: evidence.invocationDigest,
    result: evidence.result
  };
}

export class FilesystemBufBreakingQualificationEvidence
implements BufBreakingQualificationEvidencePort {
  readonly #observation: BufQualificationObservation;
  readonly #digest: Sha256DigestPort;
  readonly #assertSchema: ProtobufSchemaAssertion;

  constructor(assertSchema: ProtobufSchemaAssertion, observation: BufQualificationObservation, digest: Sha256DigestPort = new NodeSha256Digest()) {
    this.#observation = observation;
    this.#assertSchema = assertSchema;
    this.#digest = digest;
  }

  async read(
    input: ReadBufBreakingQualificationEvidenceInput
  ): Promise<ResolvedBufBreakingQualificationEvidence> {
    assertBufQualificationActive(input.signal);
    const { configuration } = input;
    const evidenceBytes = await readQualificationFile(this.#observation, {
      consumerRoot: input.consumerRoot,
      path: configuration.qualification.evidencePath,
      maxBytes: MAX_EVIDENCE_BYTES,
      label: "Buf qualification evidence"
    });
    assertBufQualificationActive(input.signal);
    const rawEvidence = this.#observation.parseYaml(
      evidenceBytes.toString("utf8"),
      "protobuf-buf-qualification-evidence"
    );
    await this.#assertSchema(
      "contract-protobuf-breaking-qualification/v1",
      rawEvidence,
      "protobuf-buf-qualification-evidence"
    );
    const evidence = mapBufBreakingQualificationEvidence(rawEvidence);
    const [bufConfigBytes, baselineDescriptorBytes] = await Promise.all([
      readQualificationFile(this.#observation, {
        consumerRoot: input.consumerRoot,
        path: configuration.qualification.bufConfigPath,
        maxBytes: MAX_BUF_CONFIG_BYTES,
        label: "Buf configuration"
      }),
      readQualificationFile(this.#observation, {
        consumerRoot: input.consumerRoot,
        path: configuration.qualification.releasedDescriptorImagePath,
        maxBytes: MAX_DESCRIPTOR_BYTES,
        label: "Released descriptor image"
      })
    ]);
    assertBufQualificationActive(input.signal);
    assertExactBufFilePolicy(
      this.#observation.parseYaml(bufConfigBytes.toString("utf8"), "protobuf-buf-config")
    );

    const observedBufConfigDigest = this.#digest.digest(bufConfigBytes);
    const observedBaselineDigest = this.#digest.digest(baselineDescriptorBytes);
    const expectedBreakingPolicyConfigDigest = this.#digest.digest(
      BUF_FILE_BREAKING_CONFIG_SOURCE
    );
    const expectedInvocationDigest = this.#digest.digest(
      canonicalBufQualificationInvocation(
        qualificationInvocationInput({
          ...configuration,
          breakingPolicyConfigDigest: expectedBreakingPolicyConfigDigest
        })
      )
    );
    const expectedFindingSetDigest = this.#digest.digest(
      canonicalBufFindingSet(evidence.result.findings)
    );
    const expectedEvidenceDigest = this.#digest.digest(
      canonicalBufQualificationEvidence(withoutEvidenceDigest(evidence))
    );

    const bindingsMatch =
      evidence.contractId === configuration.current.contractId &&
      evidence.bufVersion === configuration.current.bufVersion &&
      evidence.modulePath === configuration.qualification.modulePath &&
      evidence.bufConfigPath === configuration.qualification.bufConfigPath &&
      evidence.evidencePath === configuration.qualification.evidencePath &&
      evidence.bufConfigDigest === configuration.current.bufConfigDigest &&
      evidence.baselineDescriptorImagePath ===
        configuration.qualification.releasedDescriptorImagePath &&
      evidence.baselineDescriptorImageDigest === configuration.released.descriptorImageDigest &&
      evidence.candidateDescriptorImageDigest === configuration.current.descriptorImageDigest &&
      evidence.breakingPolicyConfigDigest === expectedBreakingPolicyConfigDigest;
    if (!bindingsMatch) {
      rejectBufQualificationInput(
        "BUF_QUALIFICATION_EVIDENCE_MISMATCH",
        "Buf qualification evidence is stale or does not match the declared contract, toolchain, paths, baseline, or candidate."
      );
    }
    if (
      observedBufConfigDigest !== configuration.current.bufConfigDigest ||
      observedBaselineDigest !== configuration.released.descriptorImageDigest
    ) {
      rejectBufQualificationInput(
        "BUF_QUALIFICATION_INPUT_DIGEST_MISMATCH",
        "Buf configuration or released descriptor bytes do not match declared digests."
      );
    }
    if (
      evidence.invocationDigest !== expectedInvocationDigest ||
      evidence.result.findingSetDigest !== expectedFindingSetDigest ||
      evidence.evidenceDigest !== expectedEvidenceDigest
    ) {
      rejectBufQualificationInput(
        "BUF_QUALIFICATION_EVIDENCE_DIGEST_MISMATCH",
        "Buf qualification evidence contains a stale or fabricated deterministic digest."
      );
    }

    return Object.freeze({
      breaking: Object.freeze({
        status: evidence.result.status,
        fingerprint: evidence.evidenceDigest
      }),
      releasedDescriptorImageDigest: evidence.baselineDescriptorImageDigest
    });
  }
}
