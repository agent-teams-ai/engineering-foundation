import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { sourceFiles } from "./package-boundary-support.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repositoryMutationName = "@agent-teams/repository-mutation";
const docsProtocolAgentTeamsName = "@agent-teams/docs-protocol-agent-teams";

const docsProtocolName = "@agent-teams/docs-protocol";

test("Agent Teams consumer integration is absent from Core and owned by its adapter", async () => {
  const policy = parseYaml(await readFile(join(
    repositoryRoot,
    "architecture/foundation/source-dependencies.yaml",
  ), "utf8"));
  const coreBoundaries = policy.boundaries.filter((boundary) =>
    boundary.roots.some((root) => root.startsWith("packages/docs-protocol/src/")),
  );
  for (const boundary of coreBoundaries) {
    assert.ok(
      boundary.roots.every((root) => !root.includes("/consumer-integration/")),
      boundary.id,
    );
    assert.ok(!boundary.allow.packages.includes(docsProtocolAgentTeamsName), boundary.id);
    assert.ok(
      boundary.allow.boundaries.every((id) => !id.startsWith("docs-protocol-agent-teams.")),
      boundary.id,
    );
  }

  const adapterBoundary = policy.boundaries.find(
    ({ id }) => id === "docs-protocol-agent-teams.adapters",
  );
  const adapterRoot = "packages/docs-protocol-agent-teams/src/consumer-integration/adapters";
  assert.deepEqual(adapterBoundary, {
    id: "docs-protocol-agent-teams.adapters",
    roots: [adapterRoot],
    allow: {
      boundaries: [
        "docs-protocol-agent-teams.application",
      ],
      packages: [
        repositoryMutationName,
        "ajv",
        "jsonc-parser",
        "yaml",
        docsProtocolName,
      ],
      builtins: [
        "node:child_process",
        "node:crypto",
        "node:fs",
        "node:fs/promises",
        "node:os",
        "node:path",
        "node:url",
      ],
      runtimeReferences: [],
    },
    entrypoints: [
      "agents-route-adapter-v1.ts", "consumer-integration-schema-validator.ts",
      "consumer-upgrade-file-projectors.ts", "foundation-known-file-transaction.ts",
      "github-cohort-authority-reader.ts", "inbound/consumer-integration-cli.ts",
      "inbound/managed-cli.ts", "managed-qualification-input.ts",
      "node-consumer-integration-repository.ts",
      "node-consumer-restoration.ts", "node-consumer-restoration-finalization.ts",
      "node-consumer-upgrade-sandbox.ts", "node-consumer-upgrade-target.ts",
      "package-consumer-asset-catalog.ts",
      "pnpm-lockfile-validator-v1.ts", "pnpm-lockfile-validator-v2.ts",
      "pnpm-manifest-adapter-v1.ts", "pnpm-manifest-adapter-v2.ts",
      "pnpm-manifest-planner.ts", "pnpm-runtime-closure-v1.ts",
      "pnpm-runtime-closure-v2.ts",
    ].map((name) => `${adapterRoot}/${name}`),
  });

  const applicationSources = await sourceFiles(join(
    repositoryRoot,
    "packages/docs-protocol-agent-teams/src/consumer-integration/application",
  ));
  for (const path of applicationSources) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /(?:^|\/)adapters(?:\/|$)/u, path);
    assert.doesNotMatch(source, /node:(?:child_process|fs|module|os|path|url)/u, path);
  }
});
