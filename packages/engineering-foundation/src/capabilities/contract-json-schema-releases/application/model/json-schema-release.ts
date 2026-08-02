export type JsonSchemaDigest = `sha256:${string}`;

export type JsonSchemaFixtureExpectation = "valid" | "invalid";

export interface JsonSchemaFixture {
  readonly id: string;
  readonly path: string;
  readonly schemaId: string;
  readonly expectation: JsonSchemaFixtureExpectation;
}

export interface JsonSchemaConsumerEvidence {
  readonly consumerId: string;
  readonly consumerVersion: string;
  readonly contractVersion: string;
  readonly fixtureCorpusDigest: JsonSchemaDigest;
  readonly evidenceDigest: JsonSchemaDigest;
  readonly outcome: "passed" | "failed";
}

export interface ReleasedJsonSchemaContractEvidence {
  readonly schemaVersion: number;
  readonly contractId: string;
  readonly publicContractVersion: string;
  readonly schemaSetDigest: JsonSchemaDigest;
  readonly fixtureCorpusDigest: JsonSchemaDigest;
  readonly supportedConsumers: readonly JsonSchemaConsumerEvidence[];
}

export interface JsonSchemaReleasePolicy {
  readonly contractId: string;
  readonly publicContractVersion: string;
  readonly schemaPaths: readonly string[];
  readonly fixtures: readonly JsonSchemaFixture[];
  readonly released: ReleasedJsonSchemaContractEvidence;
  readonly currentConsumerEvidence: readonly JsonSchemaConsumerEvidence[];
}

export interface JsonSchemaFixtureResult {
  readonly id: string;
  readonly expectation: JsonSchemaFixtureExpectation;
  readonly matched: boolean;
}

export interface JsonSchemaInspection {
  readonly schemaSetDigest: JsonSchemaDigest;
  readonly fixtureCorpusDigest: JsonSchemaDigest;
  readonly schemaIds: readonly string[];
  readonly fixtureResults: readonly JsonSchemaFixtureResult[];
}
