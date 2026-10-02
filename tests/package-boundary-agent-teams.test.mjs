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
    roots: [
      "agents-route-adapter-v1.ts", "bounded-repository-topology.ts",
      "cohort-v2-authority-validator.ts", "consumer-integration-node-error.ts",
      "consumer-integration-schema-validator.ts", "consumer-upgrade-file-projectors.ts",
      "foundation-known-file-transaction.ts", "github-cohort-authority-reader.ts",
      "managed-qualification-input.ts", "node-consumer-clock.ts",
      "node-consumer-environment.ts", "node-consumer-integration-repository.ts",
      "node-consumer-repository-files.ts", "node-consumer-restoration-evidence.ts",
      "node-consumer-restoration-finalization.ts", "node-consumer-restoration-lock.ts",
      "node-consumer-restoration-scope.ts", "node-consumer-restoration-selection.ts",
      "node-consumer-restoration.ts", "node-consumer-target-lockfile.ts",
      "node-consumer-upgrade-archive.ts", "node-consumer-upgrade-sandbox.ts",
      "node-consumer-upgrade-source-proof.ts", "node-consumer-upgrade-target.ts",
      "node-managed-runtime-identity.ts", "node-managed-runtime-process.ts",
      "node-managed-runtime.ts", "package-consumer-asset-catalog.ts",
      "pnpm-lockfile-policy-v1.ts", "pnpm-lockfile-validator-v1.ts",
      "pnpm-lockfile-validator-v2.ts", "pnpm-manifest-adapter-v1.ts",
      "pnpm-manifest-adapter-v2.ts", "pnpm-manifest-planner.ts",
      "pnpm-runtime-closure-v1.ts", "pnpm-runtime-closure-v2.ts",
      "strict-json-record.ts", "unselected-cohort-v3-loader.ts",
      "unselected-managed-profile-v4-loader.ts", "inbound",
    ].map((name) => `${adapterRoot}/${name}`),
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
        "node:stream",
        "node:timers/promises",
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
      "node-managed-runtime.ts", "node-managed-runtime-identity.ts",
      "node-managed-runtime-process.ts",
    ].map((name) => `${adapterRoot}/${name}`),
  });
  assert.deepEqual(policy.boundaries.find(
    ({ id }) => id === "docs-protocol-agent-teams.managed-runtime-probe",
  ), {
    id: "docs-protocol-agent-teams.managed-runtime-probe",
    roots: [`${adapterRoot}/managed-runtime-probe.ts`],
    allow: {
      boundaries: [],
      packages: [],
      builtins: ["node:fs"],
      runtimeReferences: ["dynamic"],
    },
    entrypoints: [],
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
