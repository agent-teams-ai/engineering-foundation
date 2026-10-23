import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export function schema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.example.test/specification/v1",
    type: "object",
    additionalProperties: false,
    required: ["id", "enabled"],
    properties: {
      id: { type: "string" },
      enabled: { type: "boolean" },
    },
  };
}

export function gates(): {
  typeGeneration?: { packageName: string; script: string };
  property: { packageName: string; script: string };
  mutation: { packageName: string; script: string };
} {
  return {
    typeGeneration: { packageName: "@example/specs", script: "spec:typegen" },
    property: { packageName: "@example/specs", script: "spec:property" },
    mutation: { packageName: "@example/specs", script: "spec:mutation" },
  };
}

export function specification(
  stateModel: { kind: string; [key: string]: unknown } = { kind: "none" },
) {
  return {
    id: "workflow-contract",
    ownerDocs: ["docs/workflow.md"],
    adrRefs: ["docs/decisions/0001-workflow.md"],
    schemaPaths: ["specifications/workflow.schema.json"],
    documents: [
      {
        path: "specifications/workflow.json",
        schemaId: "https://schemas.example.test/specification/v1",
      },
    ],
    generatedTypes: [
      {
        schemaId: "https://schemas.example.test/specification/v1",
        outputPath: "src/generated/workflow.ts",
      },
    ],
    gateBindings: gates(),
    stateModel,
  };
}

export function dataOnlySpecification(
  stateModel: { kind: string; [key: string]: unknown } = { kind: "none" },
) {
  const candidate = specification(stateModel);
  candidate.generatedTypes = [];
  delete candidate.gateBindings.typeGeneration;
  return candidate;
}

export function catalogOf(...specifications: unknown[]) {
  return {
    schemaVersion: 1,
    configPath: "quality.yaml",
    catalogPath: "architecture/specifications.json",
    specifications,
  };
}

export function deliverySpecification() {
  const second = specification();
  second.id = "delivery-contract";
  second.ownerDocs = ["docs/delivery.md"];
  second.adrRefs = ["docs/decisions/0002-delivery.md"];
  second.schemaPaths = ["specifications/delivery.schema.json"];
  second.documents = [
    {
      path: "specifications/delivery.json",
      schemaId: "https://schemas.example.test/delivery/v1",
    },
  ];
  second.generatedTypes = [
    {
      schemaId: "https://schemas.example.test/delivery/v1",
      outputPath: "src/generated/delivery.ts",
    },
  ];
  return second;
}

export async function writeFixtureJson(root: string, path: string, value: unknown): Promise<void> {
  await writeFixtureText(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFixtureText(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function withExecutableFixture<T>(
  materialize: (root: string, catalog?: unknown) => Promise<void>,
  callback: (root: string) => T | Promise<T>,
  catalog?: unknown,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "foundation-executable-specifications-"));
  try {
    await materialize(root, catalog);
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
