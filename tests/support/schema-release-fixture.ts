import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
export function digest(character: string) {
  return `sha256:${character.repeat(64)}`;
}

export async function writeJson(root: string, path: string, value: unknown) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function withContractFixture<T>(callback: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), "foundation-json-schema-release-"));
  try {
    await writeJson(root, "schemas/common.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/common.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string" } },
    });
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["id", "contact", "details"],
      properties: {
        id: { type: "string" },
        contact: { type: "string", format: "email" },
        details: { $ref: "https://schemas.example.test/agent/common.schema.json" },
      },
    });
    await writeJson(root, "fixtures/valid.json", {
      id: "task-1",
      contact: "runtime@example.test",
      details: { kind: "created" },
    });
    await writeJson(root, "fixtures/invalid.json", {
      id: 42,
      contact: "not-an-email",
      details: { kind: 7 },
    });
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export function request(root: string) {
  return {
    consumerRoot: root,
    schemaPaths: ["schemas/root.schema.json", "schemas/common.schema.json"],
    fixtures: [
      {
        id: "invalid-payload",
        path: "fixtures/invalid.json",
        schemaId: "https://schemas.example.test/agent/root.schema.json",
        expectation: "invalid",
      },
      {
        id: "valid-payload",
        path: "fixtures/valid.json",
        schemaId: "https://schemas.example.test/agent/root.schema.json",
        expectation: "valid",
      },
    ],
  };
}

export function policy(observation: { schemaSetDigest: string; fixtureCorpusDigest: string }) {
  return {
    schemaVersion: 1,
    contractId: "agent-runtime-events",
    publicContractVersion: "1.0.0",
    schemaPaths: ["schemas/root.schema.json", "schemas/common.schema.json"],
    fixtures: request("unused").fixtures,
    released: {
      schemaVersion: 1,
      contractId: "agent-runtime-events",
      publicContractVersion: "1.0.0",
      schemaSetDigest: observation.schemaSetDigest,
      fixtureCorpusDigest: observation.fixtureCorpusDigest,
      supportedConsumers: [
        {
          consumerId: "orchestrator-sdk",
          consumerVersion: "1.0.0",
          contractId: "agent-runtime-events",
          contractVersion: "1.0.0",
          schemaSetDigest: observation.schemaSetDigest,
          fixtureCorpusDigest: observation.fixtureCorpusDigest,
          evidenceDigest: digest("a"),
          outcome: "passed",
        },
      ],
    },
    currentConsumerEvidence: [
      {
        consumerId: "orchestrator-sdk",
        consumerVersion: "1.0.0",
        contractId: "agent-runtime-events",
        contractVersion: "1.0.0",
        schemaSetDigest: observation.schemaSetDigest,
        fixtureCorpusDigest: observation.fixtureCorpusDigest,
        evidenceDigest: digest("b"),
        outcome: "passed",
      },
    ],
  };
}
