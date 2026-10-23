import assert from "node:assert/strict";
import test from "node:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeScriptPublicApiExtractor } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { createWorkspaceGrowthReader } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/workspace-growth-reader.js";
import { available, required } from "./public-api-growth-matrix-fixture.ts";
import type {
  GrowthInvocation,
  GrowthSurfaceObservation,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { createHash } = await import("node:crypto");
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const { createGrowthObservation } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/observe-sdk-growth.js");

  const { FilesystemPackageArtifactInventory } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/filesystem-package-artifact-inventory.js");
  const { PnpmWorkspaceInventoryReader } =
    await import("../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js");
  const { PnpmPackageManifestSnapshotReader } =
    await import("../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-package-manifest-snapshot-reader.js");
  const { readContainedRegularFile, pathTraversesSymbolicLink } =
    await import("../packages/engineering-foundation/dist/source-inventory/node.js");
  const { AjvJsonSchemaReleaseInspector } =
    await import("../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js");

  const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
  const invocation: GrowthInvocation = {
    repository: "fixture",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    topologyDigest: digest,
    lockDigest: digest,
    toolchainDigest: digest,
    artifactDigests: [],
    tool: { version: "1", artifactDigest: digest, extractorVersion: "7.58.12" },
  };
  const cancellation = { throwIfCancelled() {} };

  void test("S1: one S1 execution reuses real workspace, Extractor and wildcard adapters and observes mutations", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ef-growth-adapters-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "package/dist"), { recursive: true });
    await mkdir(join(root, "package/schemas"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-root", private: true }),
    );
    const manifest = {
      name: "growth-fixture",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./schemas/*": "./schemas/*",
      },
    };
    await writeFile(join(root, "package/package.json"), JSON.stringify(manifest));
    await writeFile(
      join(root, "package/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", target: "ES2022", strict: true },
        files: ["dist/index.d.ts"],
      }),
    );
    await writeFile(
      join(root, "package/dist/index.d.ts"),
      "export declare function stable(value: string): string;\n",
    );
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://fixture/record/v1",
      type: "string",
      minLength: 1,
    };
    await writeFile(join(root, "package/schemas/v1.schema.json"), JSON.stringify(schema));
    const files = { read: readContainedRegularFile };
    const evidence = { files, paths: { traversesSymbolicLink: pathTraversesSymbolicLink } };
    const workspace = new PnpmWorkspaceInventoryReader(
      {
        async readYaml() {
          return { packages: ["package"] };
        },
      },
      new PnpmPackageManifestSnapshotReader({
        read: readContainedRegularFile,
        pathTraversesSymbolicLink,
      }),
    );
    const port = createGrowthObservation(
      {
        consumerRoot: root,
        workspaceManifestPath: "pnpm-workspace.yaml",
        subjects: [
          {
            packageVersion: "1.0.0",
            policy: {
              packageName: "growth-fixture",
              packageRoot: "package",
              manifestPath: "package/package.json",
              tsconfigPath: "package/tsconfig.json",
              releasedBaselinePath: "architecture/public-api/growth-fixture.json",
              approvedBreakingChanges: [],
              entrypoints: [{ exportPath: ".", declarationEntryPoint: "package/dist/index.d.ts" }],
              nonTypeExports: [{ exportPath: "./schemas/*", kind: "wildcard" }],
            },
          },
        ],
      },
      {
        workspace: createWorkspaceGrowthReader(workspace),
        typed: new TypeScriptPublicApiExtractor(evidence),
        artifact: new FilesystemPackageArtifactInventory(
          new AjvJsonSchemaReleaseInspector(files),
          evidence,
        ),
        fingerprint: {
          sha256(value: string) {
            return createHash("sha256").update(value).digest("hex");
          },
        },
      },
    );
    const nativeInvocation = {
      ...invocation,
      tool: { ...invocation.tool, extractorVersion: "typescript-native/7.0.2" },
    };
    const before = await port.observe(nativeInvocation, cancellation);
    const retained = required(
      before.compatibilitySnapshots.find((row) => row.packageName === "growth-fixture"),
    );
    assert.equal(retained.typed.snapshot.status, "available");
    assert.equal(retained.artifact.snapshot.status, "available");
    assert.equal(available(retained.typed.snapshot).extractorVersion, "typescript-native/7.0.2");
    assert.equal(
      available(retained.artifact.snapshot).extractorVersion,
      "package-artifact-inventory/1",
    );
    assert.equal(before.surface.status, "available");
    await writeFile(
      join(root, "package/dist/index.d.ts"),
      "export declare function stable(value: number): number;\n",
    );
    await writeFile(
      join(root, "package/schemas/v1.schema.json"),
      JSON.stringify({ ...schema, minLength: 2 }),
    );
    const after = await port.observe(nativeInvocation, cancellation);
    assert.equal(after.surface.status, "available");
    for (const kind of ["typed", "wildcard-member"]) {
      const first: GrowthSurfaceObservation["entries"] = available(before.surface).entries.filter(
        (row) => row.coordinate.subject.kind === kind,
      );
      const second: GrowthSurfaceObservation["entries"] = available(after.surface).entries.filter(
        (row) => row.coordinate.subject.kind === kind,
      );
      assert.equal(first.length, 1, kind);
      assert.deepEqual(
        first.map((row) => row.coordinate),
        second.map((row) => row.coordinate),
      );
      assert.notDeepEqual(
        first.map((row) => row.value),
        second.map((row) => row.value),
      );
    }
  });
}
