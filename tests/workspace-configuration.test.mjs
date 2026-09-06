import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/workspace-dependency-declarations/adapters/inbound/filesystem/load-capability-config.js";

const schema = await readFile(new URL("../packages/engineering-foundation/schemas/workspace-dependency-declarations/v1.schema.json", import.meta.url), "utf8");

test("workspace declaration configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("workspace-dependency-declarations");
});

test("source policy rejects reintroducing schema assembly inside the workspace configuration adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/workspace-dependency-declarations/adapters/inbound/filesystem/load-capability-config.ts",
    "../../../../../schema-catalog.js"
  );
});

test("workspace configuration reads the exact schema after the bounded YAML input", async () => {
  const input = { schemaVersion: 1, packageManager: { kind: "pnpm", workspaceManifest: "pnpm-workspace.yaml" }, policies: {
    externalDependencies: "catalog", catalogVersions: "exact", internalDependencies: "workspace-protocol",
    reservedScopes: ["@fixture/"], developmentOnlyPackages: ["typescript"], exactRegistryDevelopmentOnlyPackages: ["@fixture/foundation"]
  } };
  const calls = [], signal = new AbortController().signal;
  const settings = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async readSchema(...args) { calls.push(["schema", ...args]); return schema; }
  }, "explicit-memory-consumer", "dependencies.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "dependencies.yaml", "workspace-dependency-declarations-config", signal],
    ["schema", "workspace-dependency-declarations/v1"]
  ]);
  assert.deepEqual(settings, { packageManagerKind: "pnpm", workspaceManifestPath: "pnpm-workspace.yaml", policy: {
    reservedScopes: ["@fixture/"], developmentOnlyPackages: ["typescript"], exactRegistryDevelopmentOnlyPackages: ["@fixture/foundation"]
  } });
  assert.ok(Object.isFrozen(settings.policy));
  assert.ok(Object.isFrozen(settings.policy.developmentOnlyPackages));
});

test("workspace configuration preserves failure identity and does not read schema after YAML rejection", async () => {
  const failure = new Error("explicit YAML rejection");
  let schemaReads = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { throw failure; },
    async readSchema() { schemaReads += 1; return schema; }
  }, "explicit-memory-consumer", "dependencies.yaml"), (error) => error === failure);
  assert.equal(schemaReads, 0);
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { return null; },
    async readSchema() { throw failure; }
  }, "explicit-memory-consumer", "dependencies.yaml"), (error) => error === failure);
});

test("configuration observations preserve recognized errors and unknown thrown identity", async () => {
  const { mkdtemp, rm, realpath } = await import("node:fs/promises");
  const { createStrictYamlFileLoader, createPackagedSchemaReader } = await import("../packages/engineering-foundation/dist/features/configuration-input/module.js");
  const { ContainedFileReadError } = await import("../packages/engineering-foundation/dist/source-inventory/api.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "configuration-port-")));
  try {
    const calls = [];
    const loader = createStrictYamlFileLoader({ read: async (input) => {
      calls.push(input);
      return new TextEncoder().encode("value: 7");
    } });
    assert.deepEqual(await loader(root, "input.yaml", "probe"), { value: 7 });
    assert.deepEqual(calls, [{ root, candidate: join(root, "input.yaml"), maxBytes: 1024 * 1024 }]);
    for (const [failure, code] of [["escape", "CONFIG_PATH_ESCAPE"], ["invalid", "CONFIG_FILE_INVALID"], ["symlink", "CONFIG_SYMLINK_PROHIBITED"], ["changed", "CONFIG_FILE_UNAVAILABLE"], ["missing", "CONFIG_FILE_UNAVAILABLE"], ["unavailable", "CONFIG_FILE_UNAVAILABLE"]]) {
      await assert.rejects(createStrictYamlFileLoader({ read: async () => { throw new ContainedFileReadError(failure); } })(root, "input.yaml", "probe"), (error) => error.problem.code === code && error.problem.phase === "probe");
    }
    for (const unknown of [null, undefined, 0, Symbol("sentinel"), new Error("unknown"), { name: "ContainedFileReadError", failure: "escape" }]) {
      await assert.rejects(createStrictYamlFileLoader({ read: async () => { throw unknown; } })(root, "input.yaml", "probe"), (error) => error === unknown);
    }
    const controller = new AbortController();
    await assert.rejects(createStrictYamlFileLoader({ read: async () => {
      controller.abort();
      return new TextEncoder().encode("broken: [");
    } })(root, "input.yaml", "probe", controller.signal), (error) => error.problem.code === "EXECUTION_CANCELLED");
    const failure = new ContainedFileReadError("escape");
    const schemas = createPackagedSchemaReader({ packageRoot: root, files: { read: async () => { throw failure; } }, readAuthoringSchema: async (id) => id });
    assert.equal(await schemas("document-plan/v1"), "document-plan/v1");
    await assert.rejects(schemas("local/v1"), (error) => error === failure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace observations retain metadata-only discovery, 32-read batching and typed byte failures", async () => {
  const { mkdtemp, writeFile, mkdir, rm, realpath } = await import("node:fs/promises");
  const { PnpmPackageManifestSnapshotReader } = await import("../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-package-manifest-snapshot-reader.js");
  const { PnpmWorkspaceInventoryReader } = await import("../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js");
  const { ContainedFileReadError } = await import("../packages/engineering-foundation/dist/source-inventory/api.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "workspace-port-")));
  try {
    const paths = Array.from({ length: 65 }, (_, index) => `p${index}/package.json`);
    for (const path of paths) {
      await mkdir(`${root}/${path.split("/")[0]}`);
      await writeFile(`${root}/${path}`, "{}");
    }
    let active = 0, peak = 0, reads = 0;
    const releases = [];
    const files = { pathTraversesSymbolicLink: async () => false, read: async (input) => {
      assert.equal(input.maxBytes, 2 * 1024 * 1024);
      assert.equal(input.root, root);
      active += 1;
      peak = Math.max(peak, active);
      reads += 1;
      await new Promise((resolve) => {
        releases.push(resolve);
        if (reads === 32 || reads === 64 || reads === 65) {
          for (const release of releases.splice(0)) { release(); }
        }
      });
      active -= 1;
      return new TextEncoder().encode('{"name":"fixture"}');
    } };
    const manifests = new PnpmPackageManifestSnapshotReader(files);
    const inventory = await manifests.read(root, paths.toReversed(), []);
    assert.equal(reads, 65);
    assert.equal(peak, 32);
    assert.deepEqual(inventory.map((pkg) => pkg.manifestPath), paths.toSorted());
    const yamlCalls = [];
    const reader = new PnpmWorkspaceInventoryReader({ readYaml: async (...args) => {
      yamlCalls.push(args);
      return { packages: ["*"] };
    } }, { read: async () => { throw new Error("metadata discovery read package bytes"); } });
    const signal = new AbortController().signal;
    assert.equal((await reader.discoverManifestPaths(root, "workspace.yaml", signal)).length, 66);
    assert.deepEqual(yamlCalls, [[root, "workspace.yaml", "workspace-manifest", signal]]);
    for (const unknown of [undefined, null, 7, new Error("unknown"), { name: "ContainedFileReadError", failure: "escape" }]) {
      await assert.rejects(new PnpmPackageManifestSnapshotReader({ ...files, read: async () => { throw unknown; } }).read(root, [paths[0]], []), (error) => error === unknown);
    }
    for (const failure of ["changed", "escape", "invalid", "missing", "symlink", "unavailable"]) {
      await assert.rejects(new PnpmPackageManifestSnapshotReader({ ...files, read: async () => { throw new ContainedFileReadError(failure); } }).read(root, [paths[0]], []), (error) => error.problem.code === "PACKAGE_MANIFEST_INVALID");
    }
    const unknown = new Error("symlink observation failed");
    await assert.rejects(new PnpmPackageManifestSnapshotReader({ ...files, pathTraversesSymbolicLink: async () => { throw unknown; } }).read(root, [paths[0]], []), (error) => error === unknown);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
