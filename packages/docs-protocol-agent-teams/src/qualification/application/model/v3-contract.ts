import type {
  ConsumerIntegrationDesiredStateV3,
  ManagedSuccessorProfile,
  QualifiedDocsCohortBindingV2,
} from "../../../consumer-integration/application-api.js";

export type DocsProtocolQualificationCheckV3 =
  | "profile-v3"
  | "cohort-v2"
  | "five-package-closure"
  | "exact-package-versions"
  | "exact-package-integrities"
  | "schema-bindings-3-2-1"
  | "runtime-closure-digest";

export type DocsProtocolQualificationPackageKeyV3 = keyof QualifiedDocsCohortBindingV2["packages"];

export interface DocsProtocolQualificationObservedPackageV3 {
  readonly version: string;
  readonly integrity: `sha512-${string}`;
}

/** Evidence observed by the release/canary lane, never inferred from installation shape. */
export interface DocsProtocolQualificationEvidenceV3 {
  readonly packages: Readonly<
    Record<DocsProtocolQualificationPackageKeyV3, DocsProtocolQualificationObservedPackageV3>
  >;
  readonly schemas: {
    readonly consumerIntegration: number;
    readonly managedState: number;
    readonly docsProtocol: number;
  };
  readonly runtimeClosureDigest: `sha256:${string}`;
}

export interface DocsProtocolQualificationV3Request {
  readonly profile: ConsumerIntegrationDesiredStateV3;
  readonly evidence: DocsProtocolQualificationEvidenceV3;
  readonly lockfileBytes: Uint8Array;
}

export interface DocsProtocolQualificationLockfileObservationV3Request {
  readonly profile: ConsumerIntegrationDesiredStateV3;
  readonly lockfileBytes: Uint8Array;
}

export interface DocsProtocolQualificationLockfileObservationV3 {
  readonly runtimeClosureDigest: `sha256:${string}`;
}

export interface DocsProtocolQualificationPackageReceiptV3 {
  readonly key: DocsProtocolQualificationPackageKeyV3;
  readonly name: `@agent-teams/${string}`;
  readonly version: string;
  readonly integrity: `sha512-${string}`;
}

export interface DocsProtocolQualificationReceiptV3 {
  readonly schemaVersion: 3;
  readonly receiptDigest: `sha256:${string}`;
  readonly cohortAdmissible: true;
  readonly profileSchemaVersion: 3;
  readonly cohort: {
    readonly schemaVersion: 2;
    readonly cohortId: string;
    readonly recordDigest: `sha256:${string}`;
    readonly qualificationEventDigest: `sha256:${string}`;
  };
  readonly packages: readonly DocsProtocolQualificationPackageReceiptV3[];
  readonly schemas: {
    readonly consumerIntegration: 3;
    readonly managedState: 2;
    readonly docsProtocol: 1;
  };
  readonly runtime: {
    readonly runtimeClosureDigest: `sha256:${string}`;
  };
  readonly checks: readonly DocsProtocolQualificationCheckV3[];
}

export type DocsProtocolQualificationCheckCohortV3 =
  | "profile-v4"
  | "cohort-v3"
  | "cohort-assets"
  | "five-package-closure"
  | "exact-package-versions"
  | "exact-package-integrities"
  | "schema-bindings-4-3-1-qualification-receipt-1"
  | "runtime-closure-digest"
  | "policy-identity-source-digest"
  | "selected-lane-runtime"
  | "observed-node-runtime";

export interface DocsProtocolQualificationCohortEvidenceV3 {
  readonly cohort: {
    readonly cohortId: string;
    readonly recordDigest: `sha256:${string}`;
    readonly qualificationEventDigest: `sha256:${string}`;
    readonly candidateDigest: `sha256:${string}`;
  };
  readonly packages: Readonly<
    Record<DocsProtocolQualificationPackageKeyV3, DocsProtocolQualificationObservedPackageV3>
  >;
  readonly schemas: {
    readonly consumerIntegration: 4;
    readonly managedState: 3;
    readonly qualificationReceipt: 1;
    readonly docsProtocol: 1;
  };
  readonly policy: {
    readonly id: "agent-teams.docs-protocol-current-policy";
    readonly version: "3.0.0";
    readonly sourceDigest: `sha256:${string}`;
  };
  readonly runtime: {
    readonly selectedLane: "node-26-managed-qualified";
    readonly node: ">=26.0.0 <27";
    readonly pnpm: ">=11.17.0 <12";
    readonly qualificationRuntime: {
      readonly nodeVersion: "26.11.1";
      readonly pnpmVersion: "11.20.0";
      readonly platform: "linux";
      readonly architecture: "x64";
    };
    readonly runtimeClosureDigest: `sha256:${string}`;
  };
}

export interface DocsProtocolQualificationCohortV3Request {
  readonly profile: ManagedSuccessorProfile;
  readonly evidence: DocsProtocolQualificationCohortEvidenceV3;
  readonly lockfileBytes: Uint8Array;
}

export interface DocsProtocolQualificationCohortV3Receipt {
  readonly schemaVersion: 1;
  readonly namespace: "docs-protocol-cohort-v3-qualification-receipt/v1";
  readonly receiptDigest: `sha256:${string}`;
  readonly cohortAdmissible: true;
  readonly profileSchemaVersion: 4;
  readonly cohort: {
    readonly schemaVersion: 3;
    readonly cohortId: string;
    readonly recordDigest: `sha256:${string}`;
    readonly qualificationEventDigest: `sha256:${string}`;
    readonly candidateDigest: `sha256:${string}`;
  };
  readonly packages: readonly DocsProtocolQualificationPackageReceiptV3[];
  readonly schemas: {
    readonly consumerIntegration: 4;
    readonly managedState: 3;
    readonly qualificationReceipt: 1;
    readonly docsProtocol: 1;
  };
  readonly policy: {
    readonly id: "agent-teams.docs-protocol-current-policy";
    readonly version: "3.0.0";
    readonly sourceDigest: `sha256:${string}`;
  };
  readonly runtime: {
    readonly selectedLane: "node-26-managed-qualified";
    readonly node: ">=26.0.0 <27";
    readonly pnpm: ">=11.17.0 <12";
    readonly qualificationRuntime: {
      readonly nodeVersion: "26.11.1";
      readonly pnpmVersion: "11.20.0";
      readonly platform: "linux";
      readonly architecture: "x64";
    };
    readonly runtimeClosure: {
      readonly domain: "agent-teams.docs-runtime-closure/v2";
      readonly digest: `sha256:${string}`;
    };
  };
  readonly checks: readonly DocsProtocolQualificationCheckCohortV3[];
}

export interface DocsProtocolQualificationRuntimeObservation {
  readonly nodeVersion: string;
  readonly pnpmVersion?: string;
  readonly platform: string;
  readonly architecture: string;
}

export type DocsProtocolQualificationRuntimeObserver =
  () => DocsProtocolQualificationRuntimeObservation;
