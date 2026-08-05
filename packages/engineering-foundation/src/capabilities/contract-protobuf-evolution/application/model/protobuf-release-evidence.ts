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

export interface BufBreakingQualificationBinding {
  readonly modulePath: string;
  readonly bufConfigPath: string;
  readonly releasedDescriptorImagePath: string;
  readonly evidencePath: string;
}

export interface BufBreakingFinding {
  readonly path: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly type: string;
  readonly message: string;
}

export interface BufBreakingQualificationEvidence {
  readonly schemaVersion: 2;
  readonly producerId: "agent-teams-foundation.buf-breaking-qualification";
  readonly producerVersion: 2;
  readonly policy: "FILE";
  readonly contractId: string;
  readonly bufVersion: string;
  readonly modulePath: string;
  readonly bufConfigPath: string;
  readonly evidencePath: string;
  readonly bufConfigDigest: Sha256Digest;
  readonly baselineDescriptorImagePath: string;
  readonly baselineDescriptorImageDigest: Sha256Digest;
  readonly candidateDescriptorImageDigest: Sha256Digest;
  readonly breakingPolicyConfigDigest: Sha256Digest;
  readonly invocationDigest: Sha256Digest;
  readonly result: {
    readonly status: "compatible" | "breaking";
    readonly findings: readonly BufBreakingFinding[];
    readonly findingSetDigest: Sha256Digest;
    readonly rawOutputDigest: Sha256Digest;
  };
  readonly evidenceDigest: Sha256Digest;
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
  readonly qualification: BufBreakingQualificationBinding;
  readonly released: ReleasedProtobufContractEvidence;
  readonly current: CurrentProtobufContractDeclaration;
}

export interface CurrentProtobufContractDeclaration {
  readonly schemaVersion: 2;
  readonly contractId: string;
  readonly publicContractVersion: string;
  readonly bufVersion: string;
  readonly bufConfigDigest: Sha256Digest;
  readonly descriptorImageDigest: Sha256Digest;
  readonly generatorVersions: readonly BufGeneratorVersionEvidence[];
  readonly generationDrift: GenerationDriftEvidence;
}

export interface CurrentProtobufContractEvidence {
  readonly schemaVersion: 1 | 2;
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
