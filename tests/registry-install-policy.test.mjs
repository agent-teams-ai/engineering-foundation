import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exactPublicCoordinateDecision,
  registryFoundationQualificationProfile,
  registryInstallMatrix,
} from "../scripts/registry-install-policy.mjs";

const coordinates = [
  { name: "@example/docs", version: "1.2.3" },
  { name: "@example/docs-mcp", version: "2.3.4" },
];
const manifest = (name, fields = {}) => JSON.stringify({ name, version: "1.0.0", ...fields });

test("registry qualification covers npm and pnpm with docs-only and MCP profiles", () => {
  assert.deepEqual(registryInstallMatrix({
    docsPackageName: coordinates[0].name,
    mcpPackageName: coordinates[1].name,
  }), [
    { id: "npm-docs-only", manager: "npm", packageNames: [coordinates[0].name], profile: "docs-only" },
    { id: "npm-docs-mcp", manager: "npm", packageNames: coordinates.map(({ name }) => name), profile: "docs-mcp" },
    { id: "pnpm-docs-only", manager: "pnpm", packageNames: [coordinates[0].name], profile: "docs-only" },
    { id: "pnpm-docs-mcp", manager: "pnpm", packageNames: coordinates.map(({ name }) => name), profile: "docs-mcp" },
  ]);
});

test("Foundation registry qualification installs the managed Skill authority", () => {
  assert.deepEqual(registryFoundationQualificationProfile({
    adapterPackageName: "@example/docs-adapter",
    authoringPackageName: "@example/document-authoring",
    docsPackageName: "@example/docs",
    foundationPackageName: "@example/foundation",
    mcpPackageName: "@example/docs-mcp",
  }), {
    id: "npm-foundation",
    manager: "npm",
    packageNames: [
      "@example/foundation",
      "@example/document-authoring",
      "@example/docs",
      "@example/docs-adapter",
      "@example/docs-mcp",
    ],
    profile: "foundation-full",
  });
});

test("public exact-coordinate policy stays pending until every exact version exists", () => {
  assert.deepEqual(exactPublicCoordinateDecision({
    coordinates,
    publishedVersions: {
      [coordinates[0].name]: [coordinates[0].version],
      [coordinates[1].name]: ["0.0.0"],
    },
  }), {
    coordinates,
    missing: [coordinates[1]],
    status: "pending",
  });
});

test("public exact-coordinate policy becomes ready only for both exact versions", () => {
  assert.equal(exactPublicCoordinateDecision({
    coordinates,
    publishedVersions: Object.fromEntries(coordinates.map(({ name, version }) => [name, [version]])),
  }).status, "ready");
});

test("pnpm 11 rejects incompatible engines and peers under the repository install policy", async () => {
  const workspacePolicy = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  const root = await mkdtemp(join(tmpdir(), "foundation-pnpm-strict-"));
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  try {
    const engineRoot = join(root, "engine");
    await mkdir(join(engineRoot, "engine-dep"), { recursive: true });
    await writeFile(join(engineRoot, "pnpm-workspace.yaml"), workspacePolicy);
    await writeFile(join(engineRoot, "package.json"), manifest("engine-reject-fixture", {
      private: true, dependencies: { "engine-dep": "file:./engine-dep" },
    }));
    await writeFile(join(engineRoot, "engine-dep", "package.json"), manifest("engine-dep", {
      engines: { node: ">=27" },
    }));
    const engine = spawnSync(pnpm, ["install", "--offline"], { cwd: engineRoot, encoding: "utf8" });
    assert.equal(engine.status, 1, `${engine.stdout}\n${engine.stderr}`);
    assert.match(`${engine.stdout}\n${engine.stderr}`, /ERR_PNPM_UNSUPPORTED_ENGINE/u);

    const peerRoot = join(root, "peer");
    await mkdir(join(peerRoot, "peer-host"), { recursive: true });
    await mkdir(join(peerRoot, "peer-client"), { recursive: true });
    await writeFile(join(peerRoot, "pnpm-workspace.yaml"), workspacePolicy);
    await writeFile(join(peerRoot, "package.json"), manifest("peer-reject-fixture", {
      private: true, dependencies: { "peer-host": "file:./peer-host", "peer-client": "file:./peer-client" },
    }));
    await writeFile(join(peerRoot, "peer-host", "package.json"), manifest("peer-host"));
    await writeFile(join(peerRoot, "peer-client", "package.json"), manifest("peer-client", {
      peerDependencies: { "peer-host": ">=2" },
    }));
    const peer = spawnSync(pnpm, ["install", "--offline"], { cwd: peerRoot, encoding: "utf8" });
    assert.equal(peer.status, 1, `${peer.stdout}\n${peer.stderr}`);
    assert.match(`${peer.stdout}\n${peer.stderr}`, /ERR_PNPM_PEER_DEP_ISSUES/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
