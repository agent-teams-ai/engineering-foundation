import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { ownedDirectory } from "../ef70-managed-campaign/owned-root.ts";
import {
  authenticatePublishedController,
  type ControllerAuthenticationIO,
} from "../ef70-managed-campaign/controller-authentication.ts";
import { assertSourceIdentity, type SourceAdmission } from "./admission.ts";
import { freezeControllerInputs, type QualifiedTarget } from "./authority.ts";
import { AdoptionEvidence } from "./evidence.ts";
import { bytes, installedFiles, inventory, json, selected, text } from "./files.ts";
import { assertNoOwnedProcesses } from "./processes.ts";

const frozen = [
  "pnpm",
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--ignore-pnpmfile",
  "--package-import-method=copy",
  "--verify-store-integrity",
] as const;
export interface Prerequisites {
  readonly corepack: string;
  readonly controllerInstallation: string;
  readonly controllerPackage: string;
  readonly controllerCli: string;
  readonly targetLock: ReturnType<typeof selected>;
  readonly controllerArchives: readonly Row[];
}
export function prepareManagers(evidence: AdoptionEvidence): string {
  const c = evidence.config,
    installation = evidence.freshDirectory("corepack-installation");
  evidence.command(
    "corepack-install",
    c.node26,
    [
      c.npmEntrypoint,
      "install",
      "--prefix",
      installation,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      "corepack@0.36.0",
    ],
    c.roots.root,
  );
  const corepack = realpathSync(join(installation, "node_modules/corepack/dist/corepack.js"));
  assert.equal(json(join(installation, "node_modules/corepack/package.json"))["version"], "0.36.0");
  assert.equal(
    evidence
      .command("corepack-version", c.node24, [corepack, "--version"], c.roots.root)
      .toString("utf8")
      .trim(),
    "0.36.0",
  );
  c.environment["AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT"] = corepack;
  evidence.record("corepack-installation", {
    entrypoint: selected(corepack),
    lock: selected(join(installation, "package-lock.json")),
  });
  evidence.command(
    "cache-managers",
    c.node24,
    [corepack, "install", "--global", "--cache-only", "pnpm@11.18.0", "pnpm@11.20.0"],
    c.roots.root,
  );
  return corepack;
}
export function installAuthorityMetadata(evidence: AdoptionEvidence, corepack: string): void {
  const c = evidence.config,
    before = inventory(c.central);
  evidence.command("central-metadata-install", c.node26, [corepack, ...frozen], c.central);
  assert.deepEqual(inventory(c.central), before);
  assert.equal(
    evidence.git(c.central, "central-metadata-clean", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    "",
  );
}
function installationEvidence(evidence: AdoptionEvidence, root: string, label: string): void {
  const modules = join(root, "node_modules"),
    virtual = join(modules, ".pnpm");
  ownedDirectory(modules);
  ownedDirectory(virtual);
  const names = readdirSync(virtual)
    .filter((name) => name !== "node_modules" && lstatSync(join(virtual, name)).isDirectory())
    .toSorted();
  assert(names.length > 0 && names.length <= 10_000);
  evidence.retain(label + "-modules.yaml", bytes(join(modules, ".modules.yaml")));
  evidence.retain(label + "-lock.yaml", bytes(join(virtual, "lock.yaml")));
  evidence.record(label + "-installation", {
    root,
    packages: names,
    packageCount: names.length,
    scope: "Actual frozen metadata installation; no original Foundation/compiler execution.",
  });
}
function retireModules(evidence: AdoptionEvidence, root: string, label: string): void {
  const c = evidence.config;
  assert(root === c.consumer || root === join(c.roots.root, "target-cache-fixture"));
  assertNoOwnedProcesses(evidence, [root], label + "-retirement-process-census");
  const roots = evidence
    .command(
      label + "-ignored-modules",
      "/usr/bin/git",
      ["ls-files", "--others", "--ignored", "--directory", "--exclude-standard", "-z"],
      root,
    )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((name) => name.replace(/\/$/u, ""))
    .filter((name) => name.split("/").at(-1) === "node_modules");
  assert(roots.includes("node_modules"));
  const entries = roots
    .map((name) => {
      assert(!isAbsolute(name) && !name.split("/").includes(".."));
      const path = resolve(root, name);
      assert(path.startsWith(root + sep));
      ownedDirectory(path);
      const stat = lstatSync(path);
      return { path, device: stat.dev, inode: stat.ino, ownerUID: stat.uid };
    })
    .toSorted((left, right) => right.path.length - left.path.length);
  evidence.record(label + "-module-retirement-selection", entries);
  for (const entry of entries) {
    ownedDirectory(entry.path);
    const stat = lstatSync(entry.path);
    assert.equal(stat.dev, entry.device);
    assert.equal(stat.ino, entry.inode);
    assert.equal(stat.uid, entry.ownerUID);
    rmSync(entry.path, { recursive: true, force: false });
    assert(!existsSync(entry.path));
  }
  evidence.record(label + "-modules-retired", {
    roots: entries,
    reason:
      "Only this completed disposable installation is retired to prove a genuinely fresh offline import.",
  });
}
function manager(
  evidence: AdoptionEvidence,
  root: string,
  corepack: string,
  target: boolean,
): void {
  const node = target ? evidence.config.node26 : evidence.config.node24;
  assert.equal(
    evidence
      .command(
        target ? "target-manager" : "source-manager",
        node,
        [corepack, "pnpm", "--version"],
        root,
      )
      .toString("utf8")
      .trim(),
    target ? "11.20.0" : "11.18.0",
  );
}
export function prepareSourceCache(
  evidence: AdoptionEvidence,
  source: SourceAdmission,
  corepack: string,
): void {
  const c = evidence.config;
  manager(evidence, c.consumer, corepack, false);
  const environment = {
    ...c.environment,
    PATH: dirname(c.node24) + ":" + text(c.environment["PATH"], "PATH"),
  };
  evidence.command("source-frozen-online", c.node24, [corepack, ...frozen], c.consumer, {
    environment,
  });
  installationEvidence(evidence, c.consumer, "source-online");
  assert.deepEqual(inventory(c.consumer), source.images);
  retireModules(evidence, c.consumer, "source-online");
  evidence.command(
    "source-fresh-offline",
    c.node24,
    [corepack, ...frozen, "--offline"],
    c.consumer,
    { environment: { ...environment, COREPACK_ENABLE_NETWORK: "0" } },
  );
  installationEvidence(evidence, c.consumer, "source-offline");
  assert.deepEqual(inventory(c.consumer), source.images);
  assertSourceIdentity(evidence, source, "source-cache-final");
}
function targetFixture(evidence: AdoptionEvidence, source: SourceAdmission): string {
  const c = evidence.config,
    target = evidence.freshDirectory("target-cache-fixture");
  evidence.command("target-init", "/usr/bin/git", ["init", target], c.roots.root);
  evidence.git(target, "target-origin", [
    "remote",
    "add",
    "origin",
    "https://github.com/agent-teams-ai/extension-foundation.git",
  ]);
  evidence.git(target, "target-fetch", [
    "fetch",
    "--no-tags",
    "--depth=1",
    "origin",
    c.sourceRevision,
  ]);
  evidence.git(target, "target-checkout", ["checkout", "--detach", c.sourceRevision]);
  assert.equal(evidence.git(target, "target-source-head", ["rev-parse", "HEAD"]), c.sourceRevision);
  assert.equal(
    evidence.git(target, "target-source-tree", ["rev-parse", "HEAD^{tree}"]),
    source.tree,
  );
  assert.deepEqual(inventory(target), source.images);
  return target;
}
export function prepareTargetCache(
  evidence: AdoptionEvidence,
  source: SourceAdmission,
  corepack: string,
) {
  const c = evidence.config,
    selectedRoot = join(c.roots.root, "selected-lock");
  evidence.command(
    "compose-selected-lock",
    c.node26,
    [
      join(c.harness, "tools/ef70-managed-campaign/compose-selected-lock.ts"),
      c.consumer,
      c.central,
      c.targetCohort,
      selectedRoot,
    ],
    c.harness,
  );
  const composition = json(join(selectedRoot, "composition.json"));
  const lock = selected(join(selectedRoot, "pnpm-lock.yaml"));
  assert.equal(composition["sourceRevision"], c.sourceRevision);
  assert.equal(composition["sourceTree"], source.tree);
  assert.equal(composition["centralRevision"], c.authorityRevision);
  assert.equal(composition["cohortId"], c.targetCohort);
  assert.equal(composition["selectedLockSha256"], lock.sha256);
  assert.equal(composition["selectedLockPath"], lock.path);
  for (const name of ["composition.json", "pnpm-lock.yaml", "staging-package.json"]) {
    evidence.retain("composition-" + name, bytes(join(selectedRoot, name)));
  }
  const target = targetFixture(evidence, source);
  copyFileSync(join(selectedRoot, "staging-package.json"), join(target, "package.json"));
  copyFileSync(lock.path, join(target, "pnpm-lock.yaml"));
  const fixtureBefore = inventory(target);
  manager(evidence, target, corepack, true);
  evidence.command("target-frozen-online", c.node26, [corepack, ...frozen], target);
  installationEvidence(evidence, target, "target-online");
  assert.deepEqual(inventory(target), fixtureBefore);
  retireModules(evidence, target, "target-online");
  evidence.command("target-fresh-offline", c.node26, [corepack, ...frozen, "--offline"], target, {
    environment: { ...c.environment, COREPACK_ENABLE_NETWORK: "0" },
  });
  installationEvidence(evidence, target, "target-offline");
  assert.deepEqual(inventory(target), fixtureBefore);
  const packages: Row[] = [];
  for (const [name, version] of [
    ["@agent-teams/docs-protocol", "0.6.9"],
    ["@agent-teams/docs-protocol-agent-teams", "0.8.0"],
    ["@agent-teams/engineering-foundation", "4.0.3"],
    ["typescript", "7.0.2"],
  ] as const) {
    const path = realpathSync(join(target, "node_modules", name, "package.json"));
    const manifest = json(path);
    assert.equal(manifest["name"], name);
    assert.equal(manifest["version"], version);
    packages.push({ name, version, manifest: selected(path) });
  }
  evidence.record("target-fresh-offline-packages", packages);
  retireModules(evidence, target, "target-offline");
  assert.deepEqual(inventory(c.consumer), source.images);
  assertSourceIdentity(evidence, source, "target-cache-final");
  assert.deepEqual(selected(lock.path), lock);
  return lock;
}
export async function prepareController(evidence: AdoptionEvidence, target: QualifiedTarget) {
  const c = evidence.config;
  freezeControllerInputs(evidence);
  const io: ControllerAuthenticationIO = {
    fixtures: join(c.harness, "tools/ef70-managed-campaign/fixtures"),
    producerRoot: c.harness,
    rawRoot: evidence.rawRoot,
    command: (label, executable, args, cwd) => evidence.command(label, executable, args, cwd),
    fetchObserved: (url, label) => evidence.fetchObserved(url, label),
    git: (root, label, args) => evidence.git(root, label, args),
    github: (path, label) => evidence.github(path, label),
    installedFiles,
    record: (name, value) => evidence.record(name, value),
    retain: (name, content) => evidence.retain(name, content),
    selected,
  };
  const installation = join(c.roots.root, "controller");
  const archives = await authenticatePublishedController(io, {
    installation,
    node26: c.node26,
    npmEntrypoint: c.npmEntrypoint,
    coordinates: target.coordinates,
    authorityRevision: c.authorityRevision,
    candidatePath: target.candidatePath,
  });
  const controllerPackage = join(
    installation,
    "node_modules/@agent-teams/docs-protocol-agent-teams",
  );
  const cli = join(controllerPackage, "dist/cli.js");
  evidence.record("authenticated-controller-entry", selected(cli));
  return {
    controllerInstallation: installation,
    controllerPackage,
    controllerCli: cli,
    controllerArchives: archives,
  };
}
