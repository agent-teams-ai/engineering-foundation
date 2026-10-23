import {
  evidence,
  fingerprint,
  packagePolicy as fixturePackagePolicy,
  schema,
  json,
  fixture,
  inspect as fixtureInspect,
} from "./fixtures/public-api-artifact-fixture.mjs";
import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

type Snapshot =
  import("../src/capabilities/public-api-compatibility/application/model/public-api.js").PublicApiArtifactSnapshot;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const packagePolicy =
  fixturePackagePolicy as import("../src/capabilities/public-api-compatibility/application/model/public-api.js").PublicApiPackagePolicy;
const inspect = fixtureInspect as (
  ...args: Parameters<typeof fixtureInspect>
) => Promise<Mutable<Snapshot>>;
test("schema compilation uses captured bytes under A-B-A and returns the stable valid byte digest", async (t) => {
  const { FilesystemPackageArtifactInventory } =
    await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { AjvJsonSchemaReleaseInspector } =
    await import("../dist/capabilities/contract-json-schema-releases/module.js");
  const root = await fixture(t);
  const path = join(root, "package/schemas/v1.schema.json");
  const validBytes = await readFile(path);
  const stable = await inspect(root);
  assert.equal(
    stable.jsonSchemas[0]!.digest,
    `sha256:${fingerprint.sha256(validBytes.toString("utf8"))}`,
  );
  await json(root, "package/schemas/v1.schema.json", { ...schema, unknownStrictKeyword: true });
  const invalidBytes = await readFile(path);
  await assert.rejects(
    inspect(root),
    (error: unknown) =>
      (error as { problem?: { code?: unknown } }).problem?.code === "JSON_SCHEMA_COMPILE_FAILED",
  );
  let capturedReads = 0;
  const compiler = new AjvJsonSchemaReleaseInspector({
    read() {
      throw new Error("Captured inspection must not read disk");
    },
  });
  const racing = new FilesystemPackageArtifactInventory(
    {
      async inspect(input) {
        await writeFile(path, validBytes);
        try {
          const captured = await input.evidenceReader!(input.schemaPaths[0]!);
          capturedReads++;
          assert.deepEqual(captured, invalidBytes);
          // Mutating a returned copy cannot alter the bytes held by inventory or later reader calls.
          captured.fill(0);
          assert.deepEqual(await input.evidenceReader!(input.schemaPaths[0]!), invalidBytes);
          return await compiler.inspect(input);
        } finally {
          await writeFile(path, invalidBytes);
        }
      },
    },
    evidence,
  );
  await assert.rejects(
    racing.inspect(root, [packagePolicy]),
    (error: unknown) =>
      (error as { problem?: { code?: unknown } }).problem?.code === "JSON_SCHEMA_COMPILE_FAILED",
  );
  assert.equal(capturedReads, 1);
  assert.deepEqual(await readFile(path), invalidBytes);
  await writeFile(path, validBytes);
  assert.deepEqual(await inspect(root), stable);
});

test("captured schema inspection retains final byte, symlink and per-schema bounds", async (t) => {
  const { FilesystemPackageArtifactInventory } =
    await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { AjvJsonSchemaReleaseInspector } =
    await import("../dist/capabilities/contract-json-schema-releases/module.js");
  for (const change of ["bytes", "symlink", "oversized"]) {
    const root = await fixture(t);
    const path = join(root, "package/schemas/v1.schema.json");
    if (change === "oversized") {
      await json(root, "package/schemas/v1.schema.json", {
        ...schema,
        description: "a".repeat(4 * 1024 * 1024),
      });
      await assert.rejects(
        inspect(root),
        (error: unknown) =>
          (error as { problem?: { code?: unknown } }).problem?.code === "JSON_SCHEMA_FILE_INVALID",
      );
      continue;
    }
    const racing = new FilesystemPackageArtifactInventory(
      {
        async inspect(input) {
          const result = await new AjvJsonSchemaReleaseInspector(evidence.files).inspect(input);
          if (change === "bytes") {
            await json(root, "package/schemas/v1.schema.json", { ...schema, minProperties: 1 });
          } else {
            const bytes = await readFile(path);
            await writeFile(join(root, "outside.json"), bytes);
            await rm(path);
            await symlink(join(root, "outside.json"), path);
          }
          return result;
        },
      },
      evidence,
    );
    await assert.rejects(
      racing.inspect(root, [packagePolicy]),
      /changed|Special file|[Ss]ymbolic/u,
    );
  }
});

test("per-inspection captured evidence overrides path and constructor readers without missing-byte fallback", async (t) => {
  const { AjvJsonSchemaReleaseInspector } =
    await import("../dist/capabilities/contract-json-schema-releases/module.js");
  const root = await fixture(t);
  const path = "package/schemas/v1.schema.json";
  const captured = await readFile(join(root, path));
  const input = {
    consumerRoot: root,
    schemaPaths: [path],
    fixtures: [],
    requireMixedExpectations: false,
  };
  const stable = await new AjvJsonSchemaReleaseInspector(evidence.files).inspect(input);
  const inspector = new AjvJsonSchemaReleaseInspector(
    {
      read() {
        throw new Error("Unexpected filesystem fallback");
      },
    },
    async () => {
      throw new Error("Unexpected constructor-reader fallback");
    },
  );
  await json(root, path, { ...JSON.parse(captured.toString("utf8")), unknownStrictKeyword: true });
  assert.deepEqual(
    await inspector.inspect({ ...input, evidenceReader: async () => captured }),
    stable,
  );
  for (const [bytes, code] of [
    [undefined, "JSON_SCHEMA_FILE_UNAVAILABLE"],
    [Buffer.alloc(4 * 1024 * 1024 + 1), "JSON_SCHEMA_FILE_INVALID"],
    [await readFile(join(root, path)), "JSON_SCHEMA_COMPILE_FAILED"],
  ] as const) {
    await assert.rejects(
      inspector.inspect({ ...input, evidenceReader: async () => bytes }),
      (error: unknown) => (error as { problem?: { code?: unknown } }).problem?.code === code,
    );
  }
  await assert.rejects(
    inspector.inspect({
      ...input,
      schemaPaths: ["../outside.json"],
      evidenceReader: async () => captured,
    }),
  );
  await assert.rejects(
    inspector.inspect({
      ...input,
      signal: AbortSignal.abort(),
      evidenceReader: async () => captured,
    }),
  );
});
