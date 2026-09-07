import type {
  ConsumerIntegrationDesiredStateV3,
  QualifiedDocsCohortBindingV2
} from "../../../consumer-integration/application-api.js";

export type DocsProtocolQualificationCheckV3 =
  | "profile-v3"
  | "cohort-v2"
  | "five-package-closure"
  | "exact-package-versions"
  | "exact-package-integrities"
  | "schema-bindings-3-2-1"
  | "runtime-closure-digest";

export type DocsProtocolQualificationPackageKeyV3 =
  keyof QualifiedDocsCohortBindingV2["packages"];

export interface DocsProtocolQualificationObservedPackageV3 {
  readonly version: string;
  readonly integrity: `sha512-${string}`;
}

/** Evidence observed by the release/canary lane, never inferred from installation shape. */
export interface DocsProtocolQualificationEvidenceV3 {
  readonly packages: Readonly<Record<
    DocsProtocolQualificationPackageKeyV3,
    DocsProtocolQualificationObservedPackageV3
  >>;
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
