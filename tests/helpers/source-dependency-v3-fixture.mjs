import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sourceTopologyAdapters } from "../support/capability-adapters.mjs";
import { dirname, join } from "node:path";
import {
  foundationPackageRoot,
  createWorkspaceInventoryReader,
  loadCapabilityConfig,
  sourceConfigPath,
  withCopiedFixture,
} from "./source-dependency-v2-fixture.mjs";

export async function writeV3File(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof contents === "string"
    ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

export function v3Boundary(id, path) {
  return {
    id, roots: [path], entrypoints: [`${path}/index.ts`],
    allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
  };
}

export async function saveV3Policy(root, policy) {
  await writeFile(sourceConfigPath(root), `${JSON.stringify(policy, null, 2)}\n`);
}

// Generic inert producer fixture: no consumer implementation or catalog is copied.
export async function withV3Fixture(callback, { rootOnly = false } = {}) {
  return withCopiedFixture("v2-valid", async (root) => {
    await rm(join(root, "packages"), { recursive: true });
    const roots = rootOnly ? ["tooling/task/src"] : [
      "packages/domain/src", "packages/contexts/supply/src", "tooling/task/src",
    ];
    await writeV3File(root, "package.json", {
      name: "@fixture/root", private: true, type: "module",
      dependencies: { "@fixture/domain": "workspace:*" },
    });
    await writeV3File(root, "pnpm-workspace.yaml",
      "packages:\n  - packages/*\n  - packages/contexts/*\n  - apps/*\n");
    if (!rootOnly) {
      for (const [path, name] of [
        ["packages/domain", "domain"], ["packages/contexts/supply", "supply"],
      ]) {
        await writeV3File(root, `${path}/package.json`, {
          name: `@fixture/${name}`, private: true, type: "module",
          exports: { ".": "./src/index.ts" },
        });
      }
    }
    const policy = {
      schemaVersion: 3, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
      packageRoots: rootOnly ? [] : ["packages", "packages/contexts"],
      rootPackage: true, governedRoots: roots,
      boundaries: roots.map((path, index) => v3Boundary(`surface${index}`, path)),
    };
    for (const path of roots) {
      await writeV3File(root, `${path}/index.ts`, "export const value = 1;\n");
    }
    await saveV3Policy(root, policy);
    await writeV3File(root, "foundation.config.yaml", {
      schemaVersion: 1, project: { id: "source-v3-fixture" },
      capabilities: { "architecture.source-dependencies": {
        configPath: "architecture/foundation/source-dependencies.yaml",
      } },
    });
    return callback(root, policy);
  });
}

export function checkV3(root, outcome = "passed", requestedVersion = 3) {
  const cli = join(process.env.LOADER_PACKED_PACKAGE_ROOT ?? foundationPackageRoot, "dist/cli.js");
  const result = spawnSync(process.execPath, [cli, "check", "--consumer", root, "--json"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.capabilities.length, 1, result.stdout);
  const capability = report.capabilities[0];
  assert.equal(capability.capabilityId, "architecture.source-dependencies");
  assert.equal(capability.outcome, outcome, result.stdout);
  assert.equal(capability.capabilityConfigSchemaVersion, requestedVersion, result.stdout);
  assert.equal(result.status, outcome === "passed" ? 0 : 1, result.stdout);
  if (outcome === "passed") {
    assert.deepEqual(capability.diagnostics, []);
  }
  return capability;
}

export function assertV3Rule(root, rule, path) {
  const report = checkV3(root, "violations");
  assert.ok(report.diagnostics.some((diagnostic) =>
    diagnostic.ruleId === `architecture.source-dependencies.${rule}` &&
    (diagnostic.location?.path === path || diagnostic.subject === path)), JSON.stringify(report));
  return report;
}

export function assertV3Problem(root, code, path) {
  const report = checkV3(root, "invalid-input");
  assert.equal(report.problem.code, code, JSON.stringify(report));
  if (path !== undefined) {
    assert.ok(JSON.stringify(report.problem).includes(path), JSON.stringify(report));
  }
  return report;
}

export async function inspectV3Topology(root, dependencies = {}, signal) {
  const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(foundationPackageRoot, "dist");
  const { PnpmSourceWorkspaceTopologyInspector } = await import(pathToFileURL(join(
    distRoot,
    "capabilities/source-dependencies/adapters/outbound/node/pnpm-source-workspace-topology-inspector.js",
  )).href);
  const policy = await loadCapabilityConfig(root, "architecture/foundation/source-dependencies.yaml");
  return new PnpmSourceWorkspaceTopologyInspector({
    inventoryReader: createWorkspaceInventoryReader(),
    ...sourceTopologyAdapters(),
    ...dependencies,
  }).inspect({
    consumerRoot: root,
    workspaceManifestPath: policy.workspaceManifestPath,
    packageRoots: policy.packageRoots,
    governedRoots: policy.governedRoots,
    boundaryRoots: policy.boundaries.flatMap((boundary) => boundary.roots.map((path) => ({
      boundaryId: boundary.id, path,
    }))),
    v3: { includeRootPackage: policy.includeRootPackage },
    ...(signal === undefined ? {} : { signal }),
  });
}
