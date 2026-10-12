import type { SchemaObject } from "ajv";

export type JsonRecord = Record<string, unknown>;

export type Repository = Readonly<{
  provider: "github";
  id: string;
  nameWithOwner: string;
}>;

export type PackageEvidence = Readonly<Record<string, Readonly<{
  version: string;
  integrity: string;
}>>>;

export type Coordinate = Readonly<{
  key: string;
  name: string;
  version: string;
  integrity: string;
}>;

export type QualificationRuntime = Readonly<{
  nodeVersion: string;
  pnpmVersion: string;
  platform: string;
  architecture: string;
}>;

export type CohortV2Authority = Readonly<{
  schemaVersion: 2;
  cohortId: string;
  recordDigest: string;
  qualificationEventDigest: string;
  packages: JsonRecord;
  runtime: Readonly<{ runtimeClosureDigest: string }>;
}>;

export type CohortV3Authority = Readonly<{
  schemaVersion: 3;
  cohortId: string;
  recordDigest: string;
  qualificationEventDigest: string;
  candidateDigest: string;
  packages: JsonRecord;
  runtime: Readonly<{
    policy: Readonly<{ id: string; version: string; digest: string }>;
    selectedLane: string;
    node: string;
    pnpm: string;
    qualificationRuntime: QualificationRuntime;
    runtimeClosure: Readonly<{ domain: string; digest: string }>;
  }>;
}>;

export type Authority = Readonly<{
  cohort: CohortV2Authority | CohortV3Authority;
  coordinates: readonly Coordinate[];
}>;

export type LockfileEvidence = Readonly<{
  lockfileBytes: Buffer;
  receipt: Readonly<{ lockfileDigest: string }>;
}>;

export type QualificationCommandResult = Readonly<{ stdout: string }>;

export type QualificationHostPorts = Readonly<{
  parseJson: (text: string) => JsonRecord;
  readSchema: (path: string) => Promise<SchemaObject>;
  run: (
    command: string,
    args: readonly string[],
    cwd: string,
    options: Readonly<{ timeoutMs: number }>,
  ) => Promise<QualificationCommandResult>;
}>;

export type QualificationProfileV2 = Readonly<{
  schemaVersion: 3;
  repository: Repository;
  cohort: CohortV2Authority;
  [key: string]: unknown;
}>;

export type QualificationProfileV3 = Readonly<{
  schemaVersion: 4;
  repository: Repository;
  cohort: CohortV3Authority;
  [key: string]: unknown;
}>;

export type ManagedState = JsonRecord & Readonly<{
  schemaVersion: number;
  stateDigest: string;
}>;

export type SchemaCase = readonly [string, SchemaObject, unknown];
