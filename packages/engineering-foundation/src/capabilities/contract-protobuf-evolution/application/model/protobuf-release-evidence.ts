export type Sha256Digest = `sha256:${string}`;

export interface BufGeneratorVersionEvidence {
  readonly name: string;
  readonly version: string;
}

export interface ReleasedProtobufContractEvidence {
  readonly schemaVersion: number;
  readonly contractId: string;
  readonly publicContractVersion: string;
  readonly bufVersion: string;
  readonly bufConfigDigest: Sha256Digest;
  readonly descriptorImageDigest: Sha256Digest;
  readonly generatorVersions: readonly BufGeneratorVersionEvidence[];
  readonly generatedOutputDigest: Sha256Digest;
}

export interface GenerationDriftEvidence {
  readonly expectedGeneratedOutputDigest: Sha256Digest;
  readonly observedGeneratedOutputDigest: Sha256Digest;
}

export interface BufBreakingEvidence {
  readonly status: "compatible" | "breaking" | "not-run";
  readonly fingerprint?: Sha256Digest;
}

export interface ApprovedProtobufBreakingChange {
  readonly decisionId: `ADR-${string}`;
  readonly fingerprint: Sha256Digest;
}

/**
 * Protobuf-owned configuration before external acceptance evidence is resolved.
 * The referenced baseline is a versioned published language of another feature,
 * so its interpretation stays behind an application port.
 */
export interface ProtobufEvolutionConfiguration {
  readonly acceptedDecisionBaselinePath?: string;
  readonly governanceConfigPath?: string;
  readonly approvedBreakingChanges: readonly ApprovedProtobufBreakingChange[];
  readonly released: ReleasedProtobufContractEvidence;
  readonly current: CurrentProtobufContractEvidence;
}

export interface CurrentProtobufContractEvidence {
  readonly schemaVersion: number;
  readonly contractId: string;
  readonly publicContractVersion: string;
  readonly bufVersion: string;
  readonly bufConfigDigest: Sha256Digest;
  readonly descriptorImageDigest: Sha256Digest;
  readonly releasedDescriptorImageDigest: Sha256Digest;
  readonly generatorVersions: readonly BufGeneratorVersionEvidence[];
  readonly generationDrift: GenerationDriftEvidence;
  readonly breaking: BufBreakingEvidence;
}

export interface ProtobufEvolutionPolicy {
  readonly acceptedDecisionIds: readonly `ADR-${string}`[];
  readonly approvedBreakingChanges: readonly ApprovedProtobufBreakingChange[];
  readonly released: ReleasedProtobufContractEvidence;
  readonly current: CurrentProtobufContractEvidence;
}
