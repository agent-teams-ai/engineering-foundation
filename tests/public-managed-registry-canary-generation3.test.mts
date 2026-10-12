import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml, stringify } from "yaml";

import {
  runDocsProtocolQualificationV3,
  type DocsProtocolQualificationCohortV3Receipt,
  type DocsProtocolQualificationReceiptV3,
} from "../packages/docs-protocol-agent-teams/dist/qualification/index.js";
import { assertQualificationReceiptDigest } from "../scripts/public-managed-registry-canary.mjs";
import {
  cohortV3QualificationChecks,
  descriptors,
  legacyQualificationChecks,
  legacyQualificationFixture,
  sha256,
  successorQualificationFixture,
  type LegacyQualificationFixture,
  type SuccessorQualificationFixture,
} from "./public-managed-registry-canary-generation3-fixtures.mts";

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
  snapshots: Record<string, {
    dependencies: Record<string, string>;
  }>;
}

type QualificationCrossing = {
  evidence: LegacyQualificationFixture["evidence"] | SuccessorQualificationFixture["evidence"];
  lockfileBytes: Uint8Array;
  profile: LegacyQualificationFixture["profile"] | SuccessorQualificationFixture["profile"];
};

type ErrorExpectation = RegExp | {
  readonly message: string;
  readonly name: string;
};

function mutableSuccessorFixture(value: SuccessorQualificationFixture): MutableSuccessorFixture {
  return value as unknown as MutableSuccessorFixture;
}

function qualify(value: LegacyQualificationFixture): DocsProtocolQualificationReceiptV3;
function qualify(value: SuccessorQualificationFixture): DocsProtocolQualificationCohortV3Receipt;
function qualify(value: QualificationCrossing): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt;
function qualify(value: QualificationCrossing) {
  if ("cohort" in value.evidence) {
    return runDocsProtocolQualificationV3({
      profile: value.profile as SuccessorQualificationFixture["profile"],
      evidence: value.evidence,
      lockfileBytes: value.lockfileBytes,
    });
  }
  return runDocsProtocolQualificationV3({
    profile: value.profile as LegacyQualificationFixture["profile"],
    evidence: value.evidence,
    lockfileBytes: value.lockfileBytes,
  });
}

test("Host overload preserves generation2 and emits the closed generation3 qualification receipt", async () => {
  const legacy = legacyQualificationFixture();
  const legacyReceipt = qualify(legacy);
  assert.equal(legacyReceipt.schemaVersion, 3);
  assert.equal(legacyReceipt.profileSchemaVersion, 3);
  assert.equal("namespace" in legacyReceipt, false);
  assert.deepEqual(legacyReceipt.checks, legacyQualificationChecks);
  assert.deepEqual(legacyReceipt.schemas, { consumerIntegration: 3, managedState: 2, docsProtocol: 1 });
  assert.deepEqual(legacyReceipt.runtime, { runtimeClosureDigest: legacy.profile.cohort.runtime.runtimeClosureDigest });
  assertQualificationReceiptDigest(legacyReceipt);

  const successor = successorQualificationFixture();
  const actualRuntime = {
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
  };
  const qualifiedRuntime = {
    nodeVersion: "26.11.1",
    platform: "linux",
    architecture: "x64",
  };
  const qualifySuccessor = () => qualify(successor);
  if (JSON.stringify(actualRuntime) === JSON.stringify(qualifiedRuntime)) {
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
    assert.deepEqual(receipt.packages.map(({ key, name }) => [key, name]), descriptors.map(([key, name]) => [key, name]));
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
      ["docs-consumer-integration-profile/v4.schema.json", "https://agent-teams.ai/schemas/docs-consumer-integration-profile/v4"],
      ["docs-consumer-managed-state/v3.schema.json", "https://agent-teams.ai/schemas/docs-consumer-managed-state/v3"],
      ["docs-protocol-cohort-v3-qualification-receipt/v1.schema.json",
        "https://agent-teams.ai/schemas/docs-protocol-cohort-v3-qualification-receipt/v1"],
      ["docs-protocol-profile/v1.schema.json", "https://agent-teams.ai/schemas/docs-protocol-profile/v1"],
    ];
    for (const [path, id] of schemaPaths) {
      const schema = JSON.parse(await readFile(
        new URL(`../packages/docs-protocol-agent-teams/schemas/${path}`, import.meta.url),
        "utf8",
      )) as ReceiptSchema;
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
  } else {
    assert.throws(qualifySuccessor, /Qualification Cohort v3 observed Node runtime mismatch\./u);
    assert.ok(process.versions.node.startsWith("24.") || process.platform === "win32");
  }
});

test("Host qualification rejects mixed generations and evidence drift at their actual boundaries", () => {
  const legacy = legacyQualificationFixture();
  const successor = successorQualificationFixture();
  assert.throws(() => qualify({
    profile: legacy.profile,
    evidence: successor.evidence,
    lockfileBytes: legacy.lockfileBytes,
  }), /Qualification v3 evidence is invalid or incomplete\./u);
  assert.throws(() => qualify({
    profile: successor.profile,
    evidence: legacy.evidence,
    lockfileBytes: successor.lockfileBytes,
  }), /Qualification Cohort v3 evidence is invalid or incomplete\./u);

  const mutations: readonly (readonly [
    (value: SuccessorQualificationFixture) => void,
    ErrorExpectation,
  ])[] = [
    [(value) => { mutableSuccessorFixture(value).evidence.runtime.selectedLane = "node-24-production-default"; },
      /Qualification Cohort v3 runtime evidence mismatch\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.runtime.node = ">=24.18.0 <25"; },
      /Qualification Cohort v3 runtime evidence mismatch\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.runtime.qualificationRuntime.pnpmVersion = "11.19.0"; },
      /Qualification Cohort v3 runtime evidence mismatch\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.policy.sourceDigest = sha256("a"); },
      /Qualification Cohort v3 policy identity or source digest mismatch\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.runtime.runtimeClosureDigest = sha256("b"); },
      /Qualification Cohort v3 runtime closure digest mismatch\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.cohort.recordDigest = sha256("a"); },
      /Qualification Cohort v3 identity evidence does not match the profile\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.cohort.qualificationEventDigest = sha256("b"); },
      /Qualification Cohort v3 identity evidence does not match the profile\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.cohort.candidateDigest = sha256("c"); },
      /Qualification Cohort v3 identity evidence does not match the profile\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.schemas.consumerIntegration = 3; },
      /Qualification Cohort v3 requires exact schema bindings 4\/3\/1\/qualificationReceipt1\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.packages.docsProtocol.version = "0.5.1"; },
      /Qualification Cohort v3 version mismatch for @agent-teams\/docs-protocol\./u],
    [(value) => { mutableSuccessorFixture(value).evidence.packages.docsProtocol.integrity = integrity(99); },
      /Qualification Cohort v3 integrity mismatch for @agent-teams\/docs-protocol\./u],
    [(value) => {
      const target = mutableSuccessorFixture(value);
      const lock = parseYaml(target.lockfileBytes.toString("utf8")) as ParsedLockfile;
      lock.snapshots["@agent-teams/docs-protocol@1.0.2"]!.dependencies["consumer-transitive"] = "1.0.0";
      target.lockfileBytes = Buffer.from(stringify(lock));
    }, {
      name: "ConsumerIntegrationNodeError",
      message: "Runtime closure package consumer-transitive@1.0.0 must be one object."
    }],
  ];
  for (const [mutation, message] of mutations) {
    const candidate = successorQualificationFixture();
    mutation(candidate);
    assert.throws(() => qualify(candidate), message);
  }

  const legacyDrift: LegacyQualificationFixture = {
    ...legacy,
    evidence: {
      ...legacy.evidence,
      schemas: { ...legacy.evidence.schemas, managedState: 3 },
    },
  };
  assert.throws(() => qualify(legacyDrift), /Qualification v3 requires exact schema bindings 3\/2\/1\./u);
  const successorReceiptFixture = successorQualificationFixture();
  if (process.versions.node === "26.11.1" && process.platform === "linux" && process.arch === "x64") {
    const receipt = qualify(successorReceiptFixture);
    assert.throws(
      () => assertQualificationReceiptDigest({ ...receipt, receiptDigest: sha256("c") }),
      /Qualification Cohort v3 receipt digest is not independently canonical\./u,
    );
  } else {
    assert.throws(
      () => qualify(successorReceiptFixture),
      /Qualification Cohort v3 observed Node runtime mismatch\./u,
    );
    assert.ok(process.versions.node.startsWith("24.") || process.platform === "win32");
  }
});
