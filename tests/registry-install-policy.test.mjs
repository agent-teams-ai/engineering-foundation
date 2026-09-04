import assert from "node:assert/strict";
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
