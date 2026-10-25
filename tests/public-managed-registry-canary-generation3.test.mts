import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml, stringify } from "yaml";

import {
  observeDocsProtocolQualificationV3Lockfile,
  projectDocsProtocolQualificationCohortV3Authority,
  type DocsProtocolQualificationCohortV3Receipt,
  type DocsProtocolQualificationReceiptV3,
} from "../packages/docs-protocol-agent-teams/dist/qualification/index.js";
import { createDocsProtocolQualificationV3 } from "../packages/docs-protocol-agent-teams/dist/qualification/application/use-cases/qualify-v3.js";
import { parsePackedManagedRuntimePolicy } from "../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/unselected-cohort-v3-loader.js";
import {
  observeCentralCohortAuthority,
  parseCanaryInputs,
  type CanaryAuthorityFetcher,
} from "../scripts/public-managed-registry-canary-policy.mjs";
import { assertQualificationReceiptDigest } from "../scripts/public-managed-registry-canary.mjs";
import {
  cohortV3QualificationChecks,
  authorityDigest,
  descriptors,
  legacyQualificationChecks,
  digest,
  legacyQualificationFixture,
  integrity,
  sha256,
  successorCentralRegistryFixture,
  successorQualificationFixture,
  type LegacyQualificationFixture,
  type SuccessorQualificationFixture,
} from "../packages/docs-protocol-agent-teams/tests/public-managed-registry-canary-generation3-fixtures.ts";

function centralRegistrySchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["$schema", "schema_version", "organization", "policy", "cohorts", "events"],
    properties: {
      $schema: { const: "./docs-qualified-cohorts.schema.json" },
      schema_version: { const: 1 },
      organization: { const: "agent-teams-ai" },
      policy: {
        type: "object",
        additionalProperties: false,
        required: ["name", "version"],
        properties: {
          name: { const: "docs-qualified-cohorts" },
          version: { const: 1 },
        },
      },
      cohorts: {
        type: "array",
        maxItems: 4096,
        items: { type: "object" },
      },
      events: {
        type: "array",
        maxItems: 4096,
        items: { type: "object" },
      },
    },
  };
}

function cohort3NetworkFetcher(
  fixture: ReturnType<typeof successorCentralRegistryFixture>,
  registry: Record<string, unknown>,
): CanaryAuthorityFetcher {
  return async (input) => {
    const value = String(input).endsWith("/branches/main")
      ? { protected: true, commit: { sha: fixture.revision } }
      : String(input).endsWith(".schema.json")
        ? centralRegistrySchema()
        : registry;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function observeRealisticCohort3(
  registry: Record<string, unknown>,
): ReturnType<typeof observeCentralCohortAuthority> {
  const fixture = successorCentralRegistryFixture();
  const inputs = parseCanaryInputs({
    authorityRevision: fixture.revision,
    cohortId: fixture.cohort.cohortId,
    expectedCommit: "a".repeat(40),
  });
  return observeCentralCohortAuthority(
    { inputs, repository: fixture.repository },
    { fetcher: cohort3NetworkFetcher(fixture, registry) },
  );
}

interface Generation2DefaultReconstruction {
  readonly source: string;
  readonly replacement: string;
}

function reconstructGeneration2DefaultModule(input: Generation2DefaultReconstruction): string {
  const source = input.source.replaceAll("\r\n", "\n");
  const start = source.indexOf("async function defaultProjectAuthority(input) {");
  const end = source.indexOf("\n}\n\nexport async function observeCentralCohortAuthority", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(0, start) + input.replacement + source.slice(end + 2);
}

async function assertRetainedCohortBinding(cohort: Record<string, unknown>): Promise<void> {
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../packages/docs-protocol-agent-teams/schemas/qualified-docs-cohort/v3.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.compile(schema);
  const validateBinding = ajv.getSchema(`${schema.$id}#/$defs/cohortBinding`);
  assert.ok(validateBinding);
  assert.equal(validateBinding(cohort), true, JSON.stringify(validateBinding.errors));
}

interface MutableSuccessorFixture {
  evidence: {
    cohort: {
      candidateDigest: string;
      qualificationEventDigest: string;
      recordDigest: string;
    };
    packages: {
      docsProtocol: {
        integrity: string;
        version: string;
      };
    };
    policy: {
      sourceDigest: string;
    };
    runtime: {
      node: string;
      qualificationRuntime: {
        pnpmVersion: string;
      };
      runtimeClosureDigest: string;
      selectedLane: string;
    };
    schemas: {
      consumerIntegration: number;
    };
  };
  lockfileBytes: Buffer;
}

interface ReceiptSchema {
  readonly $id: string;
  readonly properties: Record<string, unknown>;
}

interface ParsedLockfile {
  snapshots: Record<
    string,
    {
      dependencies: Record<string, string>;
    }
  >;
}

type QualificationCrossing = {
  evidence: LegacyQualificationFixture["evidence"] | SuccessorQualificationFixture["evidence"];
  lockfileBytes: Uint8Array;
  profile: LegacyQualificationFixture["profile"] | SuccessorQualificationFixture["profile"];
};

type ErrorExpectation =
  | RegExp
  | {
      readonly message: string;
      readonly name: string;
    };

function isReceiptSchema(value: unknown): value is ReceiptSchema {
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "$id") ||
    !Object.hasOwn(value, "properties")
  ) {
    return false;
  }
  const candidate: Record<string, unknown> = { ...value };
  return (
    typeof candidate["$id"] === "string" &&
    candidate["properties"] !== null &&
    typeof candidate["properties"] === "object" &&
    !Array.isArray(candidate["properties"])
  );
}

function parseReceiptSchema(source: string): ReceiptSchema {
  const value: unknown = JSON.parse(source);
  if (!isReceiptSchema(value)) {
    throw new TypeError("Receipt schema identity is invalid.");
  }
  return value;
}

const syntheticRuntime = {
  nodeVersion: "26.11.1",
  pnpmVersion: "11.20.0",
  platform: "linux",
  architecture: "x64",
} as const;
const [policySchemaSource, policyAssetSource] = await Promise.all([
  readFile(
    new URL(
      "../packages/docs-protocol-agent-teams/schemas/managed-runtime-policy/v1.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL("../packages/docs-protocol-agent-teams/assets/runtime-policy.v1.json", import.meta.url),
    "utf8",
  ),
]);
const packedPolicy = parsePackedManagedRuntimePolicy(policySchemaSource, policyAssetSource);

const syntheticQualification = createDocsProtocolQualificationV3(
  (request) => {
    if (request.profile.schemaVersion === 3) {
      return observeDocsProtocolQualificationV3Lockfile({
        profile: request.profile,
        lockfileBytes: request.lockfileBytes,
      });
    }
    return observeDocsProtocolQualificationV3Lockfile({
      profile: request.profile,
      lockfileBytes: request.lockfileBytes,
    });
  },
  () => syntheticRuntime,
  () => packedPolicy,
);

function mutableSuccessorFixture(value: SuccessorQualificationFixture): MutableSuccessorFixture {
  return value as unknown as MutableSuccessorFixture;
}

function qualify(value: LegacyQualificationFixture): DocsProtocolQualificationReceiptV3;
function qualify(value: SuccessorQualificationFixture): DocsProtocolQualificationCohortV3Receipt;
function qualify(
  value: QualificationCrossing,
): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt;
function qualify(value: QualificationCrossing) {
  if ("cohort" in value.evidence) {
    return syntheticQualification({
      profile: value.profile as SuccessorQualificationFixture["profile"],
      evidence: value.evidence,
      lockfileBytes: value.lockfileBytes,
    });
  }
  return syntheticQualification({
    profile: value.profile as LegacyQualificationFixture["profile"],
    evidence: value.evidence,
    lockfileBytes: value.lockfileBytes,
  });
}

test("Host overload preserves generation2 and emits the closed generation3 qualification receipt", async () => {
  const oldSchemaSource = await readFile(
    new URL(
      "../architecture/foundation/schemas/public-managed-registry-canary-receipt-v1.schema.json",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    digest(oldSchemaSource),
    "sha256:6c3e8e5207a31e3cdc8e565ec690acdab26b0aaf1b1a40ef5fc485c2deaf6f2a",
  );
  assert.equal(
    parseReceiptSchema(oldSchemaSource).$id,
    "https://agent-teams.dev/schemas/public-managed-registry-canary-receipt-v1.schema.json",
  );

  const legacy = legacyQualificationFixture();
  const legacyReceipt = qualify(legacy);
  assert.equal(legacyReceipt.schemaVersion, 3);
  assert.equal(legacyReceipt.profileSchemaVersion, 3);
  assert.equal("namespace" in legacyReceipt, false);
  assert.deepEqual(legacyReceipt.checks, legacyQualificationChecks);
  assert.deepEqual(legacyReceipt.schemas, {
    consumerIntegration: 3,
    managedState: 2,
    docsProtocol: 1,
  });
  assert.deepEqual(legacyReceipt.runtime, {
    runtimeClosureDigest: legacy.profile.cohort.runtime.runtimeClosureDigest,
  });
  assertQualificationReceiptDigest(legacyReceipt);

  const successor = successorQualificationFixture();
  const qualifySuccessor = () => qualify(successor);
  const receipt = qualifySuccessor();
  assert.deepEqual(Object.keys(receipt).toSorted(), [
    "checks",
    "cohort",
    "cohortAdmissible",
    "namespace",
    "packages",
    "policy",
    "profileSchemaVersion",
    "receiptDigest",
    "runtime",
    "schemaVersion",
    "schemas",
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.namespace, "docs-protocol-cohort-v3-qualification-receipt/v1");
  assert.equal(receipt.cohortAdmissible, true);
  assert.equal(receipt.profileSchemaVersion, 4);
  assert.deepEqual(receipt.cohort, {
    schemaVersion: 3,
    cohortId: "docs-v3-canary",
    recordDigest: sha256("c"),
    qualificationEventDigest: sha256("d"),
    candidateDigest: sha256("e"),
  });
  assert.deepEqual(
    receipt.packages.map(({ key, name }) => [key, name]),
    descriptors.map(([key, name]) => [key, name]),
  );
  assert.deepEqual(receipt.schemas, {
    consumerIntegration: 4,
    managedState: 3,
    qualificationReceipt: 1,
    docsProtocol: 1,
  });
  assert.deepEqual(receipt.policy, {
    id: "agent-teams.docs-protocol-current-policy",
    version: "3.0.0",
    sourceDigest: successor.runtimePolicy.sourceDigest,
  });
  assert.deepEqual(receipt.runtime, {
    selectedLane: "node-26-managed-qualified",
    node: ">=26.0.0 <27",
    pnpm: ">=11.17.0 <12",
    qualificationRuntime: {
      nodeVersion: "26.11.1",
      pnpmVersion: "11.20.0",
      platform: "linux",
      architecture: "x64",
    },
    runtimeClosure: {
      domain: "agent-teams.docs-runtime-closure/v2",
      digest: successor.profile.cohort.runtime.runtimeClosure.digest,
    },
  });
  assert.deepEqual(receipt.checks, cohortV3QualificationChecks);
  assertQualificationReceiptDigest(receipt);

  const schemaPaths = [
    [
      "docs-consumer-integration-profile/v4.schema.json",
      "https://agent-teams.ai/schemas/docs-consumer-integration-profile/v4",
    ],
    [
      "docs-consumer-managed-state/v3.schema.json",
      "https://agent-teams.ai/schemas/docs-consumer-managed-state/v3",
    ],
    [
      "docs-protocol-cohort-v3-qualification-receipt/v1.schema.json",
      "https://agent-teams.ai/schemas/docs-protocol-cohort-v3-qualification-receipt/v1",
    ],
    [
      "docs-protocol-profile/v1.schema.json",
      "https://agent-teams.ai/schemas/docs-protocol-profile/v1",
    ],
  ] as const;
  for (const [path, id] of schemaPaths) {
    const schema = parseReceiptSchema(
      await readFile(
        new URL(`../packages/docs-protocol-agent-teams/schemas/${path}`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(schema.$id, id);
    if (path.startsWith("docs-protocol-cohort-v3-qualification-receipt/")) {
      assert.deepEqual(Object.keys(schema.properties).toSorted(), Object.keys(receipt).toSorted());
      for (const field of ["generation", "managedCandidate"]) {
        assert.equal(field in schema.properties, false);
        assert.equal(field in receipt, false);
      }
      assert.equal(new Ajv2020({ allErrors: true, strict: true }).compile(schema)(receipt), true);
    }
  }
});

test("Host qualification rejects mixed generations and evidence drift at their actual boundaries", async () => {
  const legacy = legacyQualificationFixture();
  const successor = successorQualificationFixture();
  assert.throws(
    () =>
      qualify({
        profile: legacy.profile,
        evidence: successor.evidence,
        lockfileBytes: legacy.lockfileBytes,
      }),
    /Qualification v3 evidence is invalid or incomplete\./u,
  );
  assert.throws(
    () =>
      qualify({
        profile: successor.profile,
        evidence: legacy.evidence,
        lockfileBytes: successor.lockfileBytes,
      }),
    /Qualification Cohort v3 evidence is invalid or incomplete\./u,
  );

  const mutations: readonly (readonly [
    (value: SuccessorQualificationFixture) => void,
    ErrorExpectation,
  ])[] = [
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.runtime.selectedLane = "node-24-production-default";
      },
      /Qualification Cohort v3 runtime evidence mismatch\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.runtime.node = ">=24.18.0 <25";
      },
      /Qualification Cohort v3 runtime evidence mismatch\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.runtime.qualificationRuntime.pnpmVersion =
          "11.19.0";
      },
      /Qualification Cohort v3 runtime evidence mismatch\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.policy.sourceDigest = sha256("a");
      },
      /Qualification Cohort v3 policy identity or source digest mismatch\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.runtime.runtimeClosureDigest = sha256("b");
      },
      /Qualification Cohort v3 runtime closure digest mismatch\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.cohort.recordDigest = sha256("a");
      },
      /Qualification Cohort v3 identity evidence does not match the profile\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.cohort.qualificationEventDigest = sha256("b");
      },
      /Qualification Cohort v3 identity evidence does not match the profile\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.cohort.candidateDigest = sha256("c");
      },
      /Qualification Cohort v3 identity evidence does not match the profile\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.schemas.consumerIntegration = 3;
      },
      /Qualification Cohort v3 requires exact schema bindings 4\/3\/1\/qualificationReceipt1\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.packages.docsProtocol.version = "0.5.1";
      },
      /Qualification Cohort v3 version mismatch for @agent-teams\/docs-protocol\./u,
    ],
    [
      (value) => {
        mutableSuccessorFixture(value).evidence.packages.docsProtocol.integrity = integrity(99);
      },
      /Qualification Cohort v3 integrity mismatch for @agent-teams\/docs-protocol\./u,
    ],
    [
      (value) => {
        const target = mutableSuccessorFixture(value);
        const lock = parseYaml(target.lockfileBytes.toString("utf8")) as ParsedLockfile;
        lock.snapshots["@agent-teams/docs-protocol@1.0.2"]!.dependencies["consumer-transitive"] =
          "1.0.0";
        target.lockfileBytes = Buffer.from(stringify(lock));
      },
      {
        name: "ConsumerIntegrationNodeError",
        message: "Runtime closure package consumer-transitive@1.0.0 must be one object.",
      },
    ],
  ];
  for (const [mutation, message] of mutations) {
    const candidate = successorQualificationFixture();
    mutation(candidate);
    assert.throws(() => qualify(candidate), message);
  }

  const wrongPnpmRuntime = {
    nodeVersion: process.versions.node,
    pnpmVersion: "11.19.0",
    platform: process.platform,
    architecture: process.arch,
  };
  const qualifyWrongPnpm = createDocsProtocolQualificationV3(
    (request) => {
      if (request.profile.schemaVersion === 3) {
        return observeDocsProtocolQualificationV3Lockfile({
          profile: request.profile,
          lockfileBytes: request.lockfileBytes,
        });
      }
      return observeDocsProtocolQualificationV3Lockfile({
        profile: request.profile,
        lockfileBytes: request.lockfileBytes,
      });
    },
    () => wrongPnpmRuntime,
    () => packedPolicy,
  );
  assert.throws(
    () =>
      qualifyWrongPnpm({
        profile: successor.profile,
        evidence: successor.evidence,
        lockfileBytes: successor.lockfileBytes,
      }),
    /Qualification Cohort v3 observed Node runtime mismatch\./u,
  );

  const legacyDrift: LegacyQualificationFixture = {
    ...legacy,
    evidence: {
      ...legacy.evidence,
      schemas: { ...legacy.evidence.schemas, managedState: 3 },
    },
  };
  assert.throws(
    () => qualify(legacyDrift),
    /Qualification v3 requires exact schema bindings 3\/2\/1\./u,
  );
  const successorReceiptFixture = successorQualificationFixture();
  const receipt = qualify(successorReceiptFixture);
  assert.throws(
    () => assertQualificationReceiptDigest({ ...receipt, receiptDigest: sha256("c") }),
    /Qualification Cohort v3 receipt digest is not independently canonical\./u,
  );
});

function mutableCentralRegistry(): {
  readonly cohorts: Record<string, unknown>[];
  readonly events: Record<string, unknown>[];
  readonly registry: Record<string, unknown>;
} {
  const registry = structuredClone(successorCentralRegistryFixture().registry);
  return {
    cohorts: registry["cohorts"] as Record<string, unknown>[],
    events: registry["events"] as Record<string, unknown>[],
    registry,
  };
}

function cohort3ProjectorInput(registry: Record<string, unknown>) {
  const fixture = successorCentralRegistryFixture();
  return {
    cohortId: fixture.cohort.cohortId,
    registry,
    repository: fixture.repository,
    revision: fixture.revision,
  };
}

test("real production default projector observes a realistic Cohort3 registry", async () => {
  const fixture = successorCentralRegistryFixture();
  const observed = await observeRealisticCohort3(fixture.registry);
  assert.deepEqual(observed.cohort, fixture.cohort);
  assert.equal("lifecycleState" in observed.cohort, false);
  assert.equal("canaryRepositoryIds" in observed.cohort, false);
  await assertRetainedCohortBinding(observed.cohort as Record<string, unknown>);
  const policy = JSON.parse(
    await readFile(
      new URL(
        "../packages/docs-protocol-agent-teams/assets/runtime-policy.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { managedCandidate: { selected: boolean; status: string } };
  assert.equal(policy.managedCandidate.selected, false);
  assert.equal(policy.managedCandidate.status, "candidate-unqualified");
});

test("disposable generation2 DEFAULT wiring is red for Cohort3 while production default is green", async () => {
  const fixture = successorCentralRegistryFixture();
  const current = await observeRealisticCohort3(fixture.registry);
  assert.deepEqual(current.cohort, fixture.cohort);

  const policyPath = new URL(
    "../scripts/public-managed-registry-canary-policy.mjs",
    import.meta.url,
  );
  const checkoutSource = await readFile(policyPath, "utf8");
  const crlfSource = checkoutSource.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  const qualificationModule = pathToFileURL(
    join(process.cwd(), "packages/docs-protocol-agent-teams/dist/qualification/index.js"),
  ).href;
  const generation2Default = `async function defaultProjectAuthority(input) {
  const { projectDocsProtocolQualificationV3Authority } = await import(${JSON.stringify(qualificationModule)});
  return projectDocsProtocolQualificationV3Authority(input);
}`;
  const sourceVariants = [
    { label: "checkout", source: checkoutSource },
    { label: "crlf", source: crlfSource },
  ] as const;
  for (const { label, source } of sourceVariants) {
    const disposablePath = join(
      process.cwd(),
      "scripts",
      `.public-managed-registry-canary-generation2-default-${process.pid}-${label}.mjs`,
    );
    await writeFile(
      disposablePath,
      reconstructGeneration2DefaultModule({ source, replacement: generation2Default }),
      "utf8",
    );
    try {
      const generation2Policy = await import(
        `${pathToFileURL(disposablePath).href}?test=${process.pid}-${label}`
      );
      const inputs = parseCanaryInputs({
        authorityRevision: fixture.revision,
        cohortId: fixture.cohort.cohortId,
        expectedCommit: "a".repeat(40),
      });
      await assert.rejects(
        generation2Policy.observeCentralCohortAuthority(
          { inputs, repository: fixture.repository },
          { fetcher: cohort3NetworkFetcher(fixture, fixture.registry) },
        ),
        /generation/iu,
      );
    } finally {
      await rm(disposablePath, { force: true });
    }
  }
});

test("real Cohort3 projection rejects wrong generation, identity and source at its actual boundaries", async () => {
  const wrongGeneration = mutableCentralRegistry();
  wrongGeneration.cohorts[0]!["cohort_generation"] = 2;
  assert.throws(
    () =>
      projectDocsProtocolQualificationCohortV3Authority(
        cohort3ProjectorInput(wrongGeneration.registry),
      ),
    /Qualification Cohort v3 projector requires cohort_generation 3\./u,
  );

  const wrongIdentity = mutableCentralRegistry();
  wrongIdentity.cohorts[0]!["record_digest"] = sha256("wrong-record-identity");
  assert.throws(
    () =>
      projectDocsProtocolQualificationCohortV3Authority(
        cohort3ProjectorInput(wrongIdentity.registry),
      ),
    /Cohort record_digest does not bind its canonical body\./u,
  );

  const wrongPolicySource = mutableCentralRegistry();
  const policyRecord = wrongPolicySource.cohorts[0]!;
  const policyIdentity = policyRecord["policy_identity"] as Record<string, unknown>;
  policyIdentity["digest"] = sha256("f");
  const { record_digest: _recordDigest, ...policyRecordBody } = policyRecord;
  policyRecord["record_digest"] = authorityDigest(
    "agent-teams.docs-qualified-cohort/v3",
    policyRecordBody,
  );
  assert.throws(
    () =>
      projectDocsProtocolQualificationCohortV3Authority(
        cohort3ProjectorInput(wrongPolicySource.registry),
      ),
    /Cohort v3 runtime differs from the packed managed policy lane\./u,
  );

  const wrongPackageSource = mutableCentralRegistry();
  const packages = wrongPackageSource.cohorts[0]!["packages"] as Record<string, unknown>[];
  const provenance = packages[0]!["provenance"] as Record<string, unknown>;
  provenance["source_repository"] = "agent-teams-ai/untrusted-source";
  assert.throws(
    () =>
      projectDocsProtocolQualificationCohortV3Authority(
        cohort3ProjectorInput(wrongPackageSource.registry),
      ),
    /repository-mutation provenance must match the closed current authority identity\./u,
  );
});
