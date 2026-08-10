import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJson } from "./pack-test-support.mjs";

export async function writeExecutableSpecificationFixture(consumerRoot, jsonContract) {
  const dataOnlySchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.agent-teams.ai/pack-consumer/data-only/v1",
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { enum: ["ready"] } }
  };
  await writeJson(
    join(consumerRoot, "architecture", "foundation", "executable-specifications.yaml"),
    {
      schemaVersion: 1,
      catalogPath: "architecture/specifications/catalog.json"
    }
  );
  await writeJson(join(consumerRoot, "architecture", "specifications", "catalog.json"), {
    schemaVersion: 1,
    specifications: [
      {
        id: "pack-consumer-events",
        ownerDocs: ["docs/guide.md"],
        adrRefs: ["docs/decisions/0001-verify-packaged-capabilities.md"],
        schemaPaths: ["contracts/json-schema/event.schema.json"],
        documents: [
          {
            path: "contracts/json-schema/fixtures/valid.json",
            schemaId: jsonContract.eventSchema.$id
          }
        ],
        generatedTypes: [
          {
            schemaId: jsonContract.eventSchema.$id,
            outputPath: "src/generated-event.ts"
          }
        ],
        gateBindings: {
          typeGeneration: {
            packageName: "foundation-pack-consumer",
            script: "spec:typegen"
          },
          property: {
            packageName: "foundation-pack-consumer",
            script: "spec:property"
          },
          mutation: {
            packageName: "foundation-pack-consumer",
            script: "spec:mutation"
          }
        },
        stateModel: { kind: "none" }
      },
      {
        id: "pack-consumer-data-only",
        ownerDocs: ["docs/data-only-specification.md"],
        adrRefs: [],
        schemaPaths: ["architecture/specifications/data-only.schema.json"],
        documents: [
          {
            path: "architecture/specifications/data-only.json",
            schemaId: dataOnlySchema.$id
          }
        ],
        generatedTypes: [],
        gateBindings: {
          property: {
            packageName: "foundation-pack-consumer",
            script: "spec:property"
          },
          mutation: {
            packageName: "foundation-pack-consumer",
            script: "spec:mutation"
          }
        },
        stateModel: { kind: "none" }
      }
    ]
  });
  await writeJson(
    join(consumerRoot, "architecture", "specifications", "data-only.schema.json"),
    dataOnlySchema
  );
  await writeJson(
    join(consumerRoot, "architecture", "specifications", "data-only.json"),
    { status: "ready" }
  );
  await writeFile(
    join(consumerRoot, "docs", "data-only-specification.md"),
    "# Data-only specification\n",
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "src", "generated-event.ts"),
    [
      'import { parse } from "jsonc-parser";',
      "export interface GeneratedEvent { readonly contact: string; }",
      "export const parseGeneratedEvent = (source: string) => parse(source);",
      ""
    ].join("\n"),
    "utf8"
  );
}
