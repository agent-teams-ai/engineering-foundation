import type { DocsNewRequest, PortableQualificationProtocol, QualificationEvidencePolicy, documentResult } from "@agent-teams/docs-protocol/qualification";
import type { ConsumerIntegrationDesiredStateV1, DocsProtocolQualificationContractV2 } from "./v2-contract.js";

export type ManagedIntegrationCandidate = Omit<ConsumerIntegrationDesiredStateV1, "schemaVersion"> & {
  readonly schemaVersion: unknown;
  readonly qualification?: {
    readonly contractPath: "architecture/foundation/docs-protocol-qualification.json";
    readonly gateCommand: "pnpm docs:protocol:check";
  };
};

export type QualifiedManagedIntegration = ManagedIntegrationCandidate & {
  readonly schemaVersion: 2;
  readonly qualification: NonNullable<ManagedIntegrationCandidate["qualification"]>;
};

type FileEvidence = { readonly path: string; readonly digest: `sha256:${string}` };
export interface ManagedQualificationEnvironment {
  readonly protocol: PortableQualificationProtocol;
  readonly resolveRoot: (root: string) => Promise<string>;
  readonly readIntegration: (root: string, path: string) => Promise<{ readonly value: ManagedIntegrationCandidate; readonly evidence: FileEvidence }>;
  readonly readContract: (root: string, path: string) => Promise<{ readonly contract: DocsProtocolQualificationContractV2; readonly evidence: FileEvidence }>;
  readonly snapshot: (root: string, policy: QualificationEvidencePolicy) => Promise<string>;
  readonly fileSnapshot: (root: string, policy: QualificationEvidencePolicy) => Promise<ReadonlyMap<string, string>>;
  readonly createDisposable: () => Promise<{
    readonly consumerRoot: string;
    readonly copyFrom: (sourceRoot: string, policy: QualificationEvidencePolicy) => Promise<void>;
    readonly dispose: () => Promise<void>;
  }>;
  readonly bootstrapInstallation: (root: string, rewrite: boolean) => Promise<{
    readonly docsVersion: string; readonly authoringVersion: string; readonly mutationVersion: string; readonly adapterVersion: string;
  }>;
  readonly overlaySkill: (root: string, path: string, enabled: boolean) => Promise<void>;
  readonly readScripts: (root: string) => Promise<Readonly<Record<string, unknown>> | undefined>;
  readonly readGolden: (root: string, path: string, label: string) => Promise<string>;
  readonly readDocument: (root: string, path: string) => Promise<string>;
  readonly interruptAndRecover: (input: {
    readonly base: Omit<DocsNewRequest, "apply">;
    readonly consumerRoot: string;
    readonly previewResult: ReturnType<typeof documentResult>;
    readonly profilePath: string;
    readonly protocol: PortableQualificationProtocol;
  }) => Promise<unknown>;
  readonly applyReachability: (root: string, action: unknown) => Promise<void>;
  readonly collectEvidence: (input: { readonly consumerRoot: string; readonly integration: QualifiedManagedIntegration }) => Promise<{
    readonly executingModule: Uint8Array;
    readonly lockfileDigest: `sha256:${string}`;
    readonly packageManifestDigest: `sha256:${string}`;
    readonly profile: FileEvidence;
    readonly skill: FileEvidence;
  }>;
}
