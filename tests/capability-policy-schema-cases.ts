import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createPackagedSchemaReader,
  createSchemaCatalog,
} from "../packages/engineering-foundation/dist/features/configuration-input/module.js";
import {
  ContainedFileReadError,
  readContainedRegularFile,
} from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { FOUNDATION_SCHEMA_IDS } from "../packages/engineering-foundation/dist/schema-ids.js";
import {
  readFoundationSchema,
  assertSchema,
} from "../packages/engineering-foundation/dist/schema-catalog.js";

async function assertReleasedSchemaInventory(): Promise<void> {
  const released: unknown = JSON.parse(
    await readFile("architecture/public-api/engineering-foundation.artifacts.json", "utf8"),
  );
  assert.ok(released !== null && typeof released === "object" && "jsonSchemas" in released);
  const rawSchemas = released.jsonSchemas;
  assert.ok(Array.isArray(rawSchemas));
  const schemas = rawSchemas.map((schema: unknown) => {
    assert.ok(
      schema !== null &&
        typeof schema === "object" &&
        "path" in schema &&
        typeof schema.path === "string" &&
        "digest" in schema &&
        typeof schema.digest === "string",
    );
    return { path: schema.path, digest: schema.digest };
  });
  const releasedIds = schemas.map((schema) =>
    schema.path.replace(/^schemas\//u, "").replace(/\.schema\.json$/u, ""),
  );
  assert.equal(new Set(releasedIds).size, releasedIds.length);
  assert.equal(releasedIds.filter((id) => id !== "quality-source-coverage/v4").length, 44);
  const expectedIds = new Set([...releasedIds, "quality-source-coverage/v4"]);
  assert.equal(expectedIds.size, 45);
  assert.deepEqual(FOUNDATION_SCHEMA_IDS.toSorted(), [...expectedIds].toSorted());
  for (const schema of schemas) {
    const bytes = await readFile(`packages/engineering-foundation/${schema.path}`);
    assert.equal(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      schema.digest,
      `${schema.path} must preserve its released bytes`,
    );
  }
}

function registerSchemaCatalogCases(): void {
  void test("schema contribution assembly preserves every published source byte and dependency registration", async () => {
    assert.equal(FOUNDATION_SCHEMA_IDS.length, 45);
    await assertReleasedSchemaInventory();

    assert.ok(FOUNDATION_SCHEMA_IDS.includes("workspace-dependency-declarations/v2"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("repository-agent-workflow/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("repository-agent-workflow/v2"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-findings-baseline/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("package-public-api-audit-request/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("package-public-api-audit-report/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("package-public-api-native-transition/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("foundation-config/v2"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-source-coverage/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-source-coverage/v2"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-source-coverage/v3"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-source-coverage/v4"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("architecture-source-dependencies/v3"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-gate-runner/v1"));
    assert.ok(FOUNDATION_SCHEMA_IDS.includes("quality-gate-runner/v2"));
    assert.equal(new Set(FOUNDATION_SCHEMA_IDS).size, FOUNDATION_SCHEMA_IDS.length);
    for (const id of FOUNDATION_SCHEMA_IDS) {
      const source = await readFoundationSchema(id);
      assert.equal(
        source,
        await readFile(
          new URL(`../packages/engineering-foundation/schemas/${id}.schema.json`, import.meta.url),
          "utf8",
        ),
      );
      await assert.rejects(
        assertSchema(id, null, "schema-parity"),
        (error) =>
          (error as { problem: { code: string; message: string } }).problem.code ===
          "SCHEMA_INVALID",
      );
    }
  });

  void test("schema validation retains dependency order, concurrent caching and bounded diagnostics", async () => {
    const reads: string[] = [];
    const sources: Record<string, unknown> = {
      child: { $id: "urn:ef2:child", type: "string" },
      parent: {
        $id: "urn:ef2:parent",
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: { x: { $ref: "urn:ef2:child" }, y: { type: "integer" } },
      },
    };
    const catalog = createSchemaCatalog({
      schemaIds: ["parent", "child"],
      dependencies: { parent: ["child"] },
      async readSchema(id) {
        reads.push(id);
        return JSON.stringify(sources[id]);
      },
    });
    await Promise.all([
      catalog.assertSchema("parent", { x: "ok", y: 1 }, "input"),
      catalog.assertSchema("parent", { x: "ok", y: 2 }, "input"),
    ]);
    assert.deepEqual(reads, ["child", "parent"]);
    assert.equal(catalog.isSchemaId("child"), true);
    assert.equal(catalog.isSchemaId("missing"), false);
    await assert.rejects(
      catalog.assertSchema("parent", { x: 1, y: "bad" }, "input"),
      (error) =>
        (error as { problem: { code: string; message: string } }).problem.message ===
        "/x must be string; /y must be integer",
    );
    const many = createSchemaCatalog({
      schemaIds: ["many"],
      dependencies: {},
      async readSchema() {
        const required = Array.from({ length: 20 }, (_, i) => `missing${i}`);
        return JSON.stringify({
          $id: "urn:ef2:many",
          type: "object",
          required,
          properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
        });
      },
    });
    await assert.rejects(
      many.assertSchema("many", {}, "input"),
      (error) =>
        (error as { problem: { code: string; message: string } }).problem.message.split("; ")
          .length === 8 &&
        (error as { problem: { code: string; message: string } }).problem.message.length <= 1000,
    );
  });

  registerPackagedSchemaObservationCases();
}

function registerPackagedSchemaObservationCases(): void {
  void test("packaged schema observation enforces the existing contained-file bound before retaining bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-schema-bound-"));
    try {
      await mkdir(join(root, "schemas"));
      const reader = createPackagedSchemaReader({
        packageRoot: root,
        files: { read: readContainedRegularFile },
        async readAuthoringSchema() {
          throw new Error("unexpected external schema");
        },
      });
      const bytes = " ".repeat(1024 * 1024);
      await writeFile(join(root, "schemas/large.schema.json"), bytes);
      assert.equal(await reader("large"), bytes);
      await writeFile(join(root, "schemas/large.schema.json"), bytes + " ");
      await assert.rejects(
        reader("large"),
        (error) => error instanceof ContainedFileReadError && error.failure === "invalid",
      );
      await assert.rejects(
        reader("../outside"),
        (error) =>
          (error as { problem: { code: string; message: string } }).problem.code ===
          "CONFIG_PATH_INVALID",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void test(
    "packaged schema observation refuses file and ancestor symlinks",
    { skip: process.platform === "win32" },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "foundation-schema-symlink-"));
      try {
        await mkdir(join(root, "schemas"));
        await mkdir(join(root, "real"));
        await writeFile(join(root, "real/value.schema.json"), "{}");
        await symlink(join(root, "real/value.schema.json"), join(root, "schemas/file.schema.json"));
        await symlink(join(root, "real"), join(root, "schemas/ancestor"));
        const reader = createPackagedSchemaReader({
          packageRoot: root,
          files: { read: readContainedRegularFile },
          async readAuthoringSchema() {
            throw new Error("unexpected external schema");
          },
        });
        for (const id of ["file", "ancestor/value"]) {
          await assert.rejects(
            reader(id),
            (error) => error instanceof ContainedFileReadError && error.failure === "symlink",
          );
        }
        await rm(join(root, "schemas"), { recursive: true });
        await symlink(join(root, "real"), join(root, "schemas"));
        await assert.rejects(
          reader("value"),
          (error) => error instanceof ContainedFileReadError && error.failure === "symlink",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

function registerSuppressionSnapshotCase(): void {
  void test("suppression analysis consumes explicit snapshots and preserves scanner failures", async () => {
    const { analyzeSuppressionGovernance } =
      await import("../packages/engineering-foundation/dist/capabilities/suppression-governance/api.js");
    const { OxcSuppressionScanner } =
      await import("../packages/engineering-foundation/dist/capabilities/suppression-governance/adapters/outbound/oxc/oxc-suppression-scanner.js");
    const signal = new AbortController().signal;
    const input = {
      consumerRoot: "/inert",
      policy: { governedRoots: ["src"], nonWaivableRulePrefixes: [], waivers: [] },
      signal,
    };
    const reader = {
      async read(root: string, roots: readonly string[], observedSignal?: AbortSignal) {
        assert.equal(root, input.consumerRoot);
        assert.deepEqual(roots, ["src"]);
        assert.equal(observedSignal, signal);
        return [{ path: "src/test.ts", source: "// @ts-ignore\nexport const value = 1;" }];
      },
    };
    const dependencies = {
      sourceReader: reader,
      scanner: new OxcSuppressionScanner(),
      clock: { today: () => "2026-09-05" },
    };
    const diagnostics = await analyzeSuppressionGovernance(input, dependencies);
    assert.ok(
      diagnostics.some(
        ({ ruleId }) =>
          ruleId === "quality.suppression-governance.prohibited-typescript-suppression",
      ),
    );
    const failure = new Error("snapshot unavailable");
    await assert.rejects(
      analyzeSuppressionGovernance(input, {
        ...dependencies,
        sourceReader: {
          async read() {
            throw failure;
          },
        },
      }),
      (error) => error === failure,
    );
  });
}

function registerHistoricalSchemaCase(): void {
  void test("owner-selected historical schemas preserve exact bytes and contained observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-owner-schema-"));
    try {
      const relativeFile = "assets/legacy/plan.schema.json";
      const bytes = await readFile(
        new URL(
          "../packages/engineering-foundation/assets/transaction-coordination/historical/document-plan-v1.schema.json",
          import.meta.url,
        ),
      );
      await mkdir(join(root, "assets/legacy"), { recursive: true });
      await writeFile(join(root, relativeFile), bytes);
      const calls: Parameters<typeof readContainedRegularFile>[0][] = [];
      const reader = createPackagedSchemaReader({
        packageRoot: root,
        schemaFiles: { "document-plan/v1": relativeFile },
        files: {
          async read(input) {
            calls.push(input);
            return readContainedRegularFile(input);
          },
        },
        async readAuthoringSchema() {
          throw new Error("Current Authoring cannot redefine historical Plan bytes");
        },
      });
      assert.equal(await reader("document-plan/v1"), bytes.toString("utf8"));
      assert.deepEqual(calls, [
        { candidate: join(root, relativeFile), root, maxBytes: 1024 * 1024 },
      ]);
      const escaped = createPackagedSchemaReader({
        packageRoot: root,
        schemaFiles: { "document-plan/v1": "../outside.json" },
        files: {
          async read() {
            throw new Error("escaped resource must not be observed");
          },
        },
        async readAuthoringSchema() {
          throw new Error("escaped resource must not delegate");
        },
      });
      await assert.rejects(
        escaped("document-plan/v1"),
        (error) =>
          (error as { problem: { code: string; message: string } }).problem.code ===
          "CONFIG_PATH_INVALID",
      );
      const inheritedSchemaFiles: Record<string, string> = {};
      Object.setPrototypeOf(inheritedSchemaFiles, { "document-plan/v1": "../outside.json" });
      const inherited = createPackagedSchemaReader({
        packageRoot: root,
        schemaFiles: inheritedSchemaFiles,
        files: {
          async read() {
            throw new Error("inherited mapping must not be observed");
          },
        },
        async readAuthoringSchema(id) {
          return id;
        },
      });
      assert.equal(await inherited("document-plan/v1"), "document-plan/v1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

export function registerCapabilityPolicySchemaCases(): void {
  registerSchemaCatalogCases();
  registerSuppressionSnapshotCase();
  registerHistoricalSchemaCase();
}
