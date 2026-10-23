import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./managed-runtime-fixtures.mjs";
import type { ManagedRuntimeFixture } from "./managed-runtime-fixtures.mjs";
import { sha } from "./managed-runtime-corrective-helpers.mts";
import type { RuntimeLane } from "./managed-runtime-corrective-helpers.mts";
import { createNodeManagedRuntimeScope } from "../dist/consumer-integration/adapters/node-managed-runtime.js";
export async function setup(lane: RuntimeLane, scenario: string) {
  const f: ManagedRuntimeFixture = await fixture(lane);
  const external = join(f.root, "TEST-attempt-records");
  const consumer = join(f.root, "TEST-consumer");
  await Promise.all([mkdir(external), mkdir(consumer)]);
  const controller = new AbortController();
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal: controller.signal,
  });
  const admission = await scope.admit();
  assert.equal(admission.outcome, "admitted");
  const acquisition = await scope.acquireAttempt({
    externalRoot: external,
    consumerRoot: consumer,
    controllerBuildDigest: "1".repeat(64),
    role: "source",
    runtime: admission.runtime,
    signal: controller.signal,
  });
  assert.equal(acquisition.outcome, "acquired");
  const root = acquisition.attempt.ownedRoot;
  const manifest =
    JSON.stringify({
      name: "test-managed-install",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@11.20.0",
      dependencies: {},
    }) + "\n";
  const workspace = "packages: []\n";
  await writeFile(join(root, "package.json"), manifest);
  await writeFile(join(root, "pnpm-workspace.yaml"), workspace);
  const installationRoot = scope.ownedInstallationRoot();
  assert.ok(installationRoot);
  const input = {
    root: installationRoot,
    runtime: admission.runtime,
    mode: "prepare" as const,
    expectedManifestDigest: sha(manifest),
    expectedWorkspaceDigest: sha(workspace),
    expectedLockDigest: null,
    signal: controller.signal,
  };
  return { f, scope, acquisition, root, input, controller, scenario };
}
