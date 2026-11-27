import assert from "node:assert/strict";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { AdoptionEvidence } from "../ef70-managed-adoption/evidence.ts";
import { bytes, inventory, json, selected, text } from "../ef70-managed-adoption/files.ts";
import { assertNoOwnedProcesses } from "../ef70-managed-adoption/processes.ts";
import { cloneFixture, type admitCheckouts } from "./checkouts.ts";

const frozen = [
  "pnpm",
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--ignore-pnpmfile",
  "--package-import-method=copy",
  "--verify-store-integrity",
] as const;
export interface SourceInstallation {
  readonly packages: readonly string[];
  readonly lock: Buffer;
  readonly manifests: readonly Row[];
}
function observeInstallation(
  evidence: AdoptionEvidence,
  root: string,
  label: string,
): SourceInstallation {
  const modules = realpathSync(join(root, "node_modules"));
  assert.equal(modules, join(root, "node_modules"));
  const virtual = join(modules, ".pnpm");
  const packages = readdirSync(virtual)
    .filter((name) => name !== "node_modules" && lstatSync(join(virtual, name)).isDirectory())
    .toSorted();
  assert(packages.length > 0 && packages.length <= 10_000);
  const lock = bytes(join(virtual, "lock.yaml"));
  evidence.retain(label + "-installed-lock.yaml", lock);
  evidence.retain(label + "-modules.yaml", bytes(join(modules, ".modules.yaml")));
  const manifests: Row[] = [];
  for (const name of [
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/engineering-foundation",
    "typescript",
  ]) {
    const path = realpathSync(join(modules, name, "package.json"));
    assert(path.startsWith(modules + sep));
    const manifest = json(path);
    assert.equal(manifest["name"], name);
    manifests.push({ name, version: manifest["version"], sha256: selected(path).sha256 });
  }
  evidence.record(label + "-installation", {
    root,
    packages,
    manifests,
    lock: selected(join(virtual, "lock.yaml")),
    scope: "Read inert package manifests only; never execute original Foundation or its compiler.",
  });
  return { packages, lock, manifests };
}
function install(
  evidence: AdoptionEvidence,
  input: {
    readonly root: string;
    readonly corepack: string;
    readonly target: boolean;
    readonly offline: boolean;
    readonly label: string;
  },
): SourceInstallation {
  const c = evidence.config;
  const before = inventory(input.root);
  const node = input.target ? c.node26 : c.node24;
  const environment = {
    ...c.environment,
    PATH: dirname(node) + ":" + text(c.environment["PATH"], "PATH"),
    ...(input.offline ? { COREPACK_ENABLE_NETWORK: "0" } : {}),
  };
  assert.equal(
    evidence
      .command(input.label + "-manager", node, [input.corepack, "pnpm", "--version"], input.root, {
        environment,
      })
      .toString("utf8")
      .trim(),
    input.target ? "11.20.0" : "11.18.0",
  );
  evidence.command(
    input.label,
    node,
    [input.corepack, ...frozen, ...(input.offline ? ["--offline"] : [])],
    input.root,
    { environment },
  );
  assert.deepEqual(inventory(input.root), before);
  assertNoOwnedProcesses(evidence, [input.root], input.label + "-settled");
  return observeInstallation(evidence, input.root, input.label);
}
export function prepareCaches(
  evidence: AdoptionEvidence,
  checkouts: ReturnType<typeof admitCheckouts>,
  corepack: string,
): SourceInstallation {
  install(evidence, {
    root: checkouts.originalRoot,
    corepack,
    target: false,
    offline: false,
    label: "source-frozen-online",
  });
  const sourceOffline = cloneFixture(
    evidence,
    checkouts.originalRevision,
    "source-offline-fixture",
  );
  assert.deepEqual(inventory(sourceOffline), checkouts.original.images);
  const expectedSource = install(evidence, {
    root: sourceOffline,
    corepack,
    target: false,
    offline: true,
    label: "source-fresh-offline",
  });
  const targetWarm = cloneFixture(evidence, evidence.config.sourceRevision, "target-cache-fixture");
  assert.deepEqual(inventory(targetWarm), checkouts.current.images);
  install(evidence, {
    root: targetWarm,
    corepack,
    target: true,
    offline: false,
    label: "target-frozen-online",
  });
  install(evidence, {
    root: evidence.config.consumer,
    corepack,
    target: true,
    offline: true,
    label: "target-fresh-offline",
  });
  assert.deepEqual(inventory(evidence.config.consumer), checkouts.current.images);
  evidence.record("frozen-cache-boundary", {
    source: checkouts.originalRevision,
    target: evidence.config.sourceRevision,
    freshSeparateOfflineRoots: true,
    noSourceExecution: true,
    noSelectedLockComposition: true,
    retainedOnlineFixtures: [checkouts.originalRoot, targetWarm],
  });
  return expectedSource;
}
export function assertInstalledSource(
  evidence: AdoptionEvidence,
  expected: SourceInstallation,
): void {
  const actual = observeInstallation(evidence, evidence.config.consumer, "actual-restored-source");
  assert.deepEqual(actual.packages, expected.packages);
  assert(actual.lock.equals(expected.lock));
  assert.deepEqual(actual.manifests, expected.manifests);
}
