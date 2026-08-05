import type {
  BufBreakingEvidence,
  ProtobufEvolutionConfiguration,
  Sha256Digest
} from "../model/protobuf-release-evidence.js";

export interface ReadBufBreakingQualificationEvidenceInput {
  readonly consumerRoot: string;
  readonly configuration: ProtobufEvolutionConfiguration;
  readonly signal?: AbortSignal;
}

export interface ResolvedBufBreakingQualificationEvidence {
  readonly breaking: BufBreakingEvidence;
  readonly releasedDescriptorImageDigest: Sha256Digest;
}

export interface BufBreakingQualificationEvidencePort {
  read(
    input: ReadBufBreakingQualificationEvidenceInput
  ): Promise<ResolvedBufBreakingQualificationEvidence>;
}
