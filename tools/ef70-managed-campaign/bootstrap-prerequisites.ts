import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthoritySelection } from "./authority-selection.ts";
import {
  authorityOrigin,
  candidateDigest,
  clone,
  cohort,
  command,
  fileHash,
  frozen,
  git,
  invoke,
  json,
  list,
  record,
  retain,
  retainInstall,
  retireFixtureModules,
  roots,
  row,
  selected,
  selectedEnvironment,
  selectedLockDigest,
  sourceOrigin,
  sourceRevision,
  sourceTree,
  text,
  toolsRoot,
  trackedImages,
  type HostedRuntime,
  type Row,
} from "./bootstrap-io.ts";

export function preparePackageManagers(host: HostedRuntime): string {
  const { node24, node26, npmEntrypoint } = host;
  const corepackInstallation = join(roots.root, "corepack-installation");
  mkdirSync(corepackInstallation, { mode: 0o700 });
  command(
    "corepack-install",
    node26,
    [
      npmEntrypoint,
      "install",
      "--prefix",
      corepackInstallation,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      "corepack@0.36.0",
    ],
    roots.root,
  );
  const corepackEntrypoint = realpathSync(
    join(corepackInstallation, "node_modules/corepack/dist/corepack.js"),
  );
  assert.equal(
    json(join(corepackInstallation, "node_modules/corepack/package.json"))["version"],
    "0.36.0",
  );
  assert.equal(
    command("corepack-version", node24, [corepackEntrypoint, "--version"], roots.root)
      .toString("utf8")
      .trim(),
    "0.36.0",
  );
  selectedEnvironment["AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT"] = corepackEntrypoint;
  record("corepack-installation", {
    entrypoint: selected(corepackEntrypoint),
    packageLock: selected(join(corepackInstallation, "package-lock.json")),
  });
  command(
    "cache-package-managers",
    node24,
    [corepackEntrypoint, "install", "--global", "--cache-only", "pnpm@11.18.0", "pnpm@11.20.0"],
    roots.root,
  );
  return corepackEntrypoint;
}

export function prepareSourceFixture(host: HostedRuntime, corepackEntrypoint: string) {
  const { node24 } = host;
  const sourceRoot = join(roots.root, "source-8c16");
  clone("source", sourceOrigin, sourceRoot, sourceRevision, sourceTree);
  const sourceImages = trackedImages(sourceRoot, "source-before");
  assert.equal(sourceImages.length, 452);
  assert.equal(readFileSync(join(sourceRoot, ".node-version"), "utf8"), "26.12.1\n");
  assert.equal(lstatSync(join(sourceRoot, ".node-version")).mode & 0o777, 0o644);
  record("source-before", sourceImages);
  assert.equal(
    command("source-manager", node24, [corepackEntrypoint, "pnpm", "--version"], sourceRoot)
      .toString("utf8")
      .trim(),
    "11.18.0",
  );
  command("source-frozen-install", node24, [corepackEntrypoint, ...frozen], sourceRoot, {
    PATH: dirname(node24) + ":" + text(process.env["PATH"], "Runner PATH"),
  });
  retainInstall(sourceRoot, "source", 346);
  assert.deepEqual(trackedImages(sourceRoot, "source-after"), sourceImages);
  retireFixtureModules(sourceRoot, "source-cache");
  return { sourceRoot, sourceImages };
}

export async function prepareAuthority(
  host: HostedRuntime,
  corepackEntrypoint: string,
  authority: AuthoritySelection,
) {
  const { node26 } = host;
  const centralRoot = join(roots.root, "central-authority-q");
  clone("central", authorityOrigin, centralRoot, authority.revision, authority.tree);
  command("central-metadata-install", node26, [corepackEntrypoint, ...frozen], centralRoot);
  assert.equal(
    git(centralRoot, "central-after-install", ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
  );
  const candidatePath = join(
    centralRoot,
    "governance/evidence/docs-cohorts/" + cohort + "/candidate-input.json",
  );
  assert.equal(fileHash(candidatePath), candidateDigest);
  const candidateValue = json(candidatePath);
  assert.equal(candidateValue["qualified"], false);
  const proposed = row(candidateValue["proposedRecord"], "Candidate record");
  assert.equal(proposed["cohort_id"], cohort);
  const registry = json(join(centralRoot, "governance/docs-qualified-cohorts.json"));
  const selectedRecords = list(registry["cohorts"], "Qualified cohort records")
    .map((value) => row(value, "Qualified cohort"))
    .filter((value) => value["cohort_id"] === cohort);
  assert.equal(selectedRecords.length, 1);
  const qualified = selectedRecords[0]!;
  assert.equal(qualified["candidate_digest"], "sha256:" + candidateDigest);
  for (const [key, value] of Object.entries(proposed)) {
    assert.deepEqual(qualified[key], value);
  }
  const owner = row(
    await import(pathToFileURL(join(centralRoot, "scripts/docs-cohort-policy.mjs")).href),
    "Actual Central policy module",
  );
  invoke(owner, "validateDocsQualifiedCohorts", [
    registry,
    json(join(centralRoot, "governance/docs-qualified-cohorts.schema.json")),
  ]);
  const projection = row(
    invoke(owner, "qualifiedCohortProjection", [registry, cohort]),
    "Qualified projection",
  );
  assert.equal(projection["schemaVersion"], 3);
  assert.equal(projection["lifecycleState"], "QUALIFIED");
  assert.deepEqual(projection["canaryRepositoryIds"], ["1333298097"]);
  record("qualified-projection", projection);
  const identityPath = join(centralRoot, "governance/commit-author-identity.json");
  const identityOwner = row(json(identityPath)["owner"], "Current protected owner identity");
  assert.equal(identityOwner["login"], "777genius");
  const sourceOwner = {
    login: identityOwner["login"],
    name: text(identityOwner["name"], "Canonical name"),
    email: text(identityOwner["email"], "Canonical email"),
    identityPath,
    identitySha256: "sha256:" + fileHash(identityPath),
    scope: "Disposable local fixture commits only; no remote commit, branch or publication.",
  };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) {
    assert.equal(process.env[name], sourceOwner.name);
  }
  for (const name of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) {
    assert.equal(process.env[name], sourceOwner.email);
  }
  return { centralRoot, candidatePath, qualified, sourceOwner };
}

export function prepareTargetFixture(
  host: HostedRuntime,
  corepackEntrypoint: string,
  sourceRoot: string,
  centralRoot: string,
): string {
  const { node26 } = host;
  const selectedRoot = join(roots.root, "selected-lock-c35");
  command(
    "compose-selected-lock",
    node26,
    [join(toolsRoot, "compose-selected-lock.ts"), sourceRoot, centralRoot, cohort, selectedRoot],
    roots.root,
  );
  const targetLockPath = join(selectedRoot, "pnpm-lock.yaml");
  assert.equal(fileHash(targetLockPath), selectedLockDigest);
  for (const name of readdirSync(selectedRoot).toSorted()) {
    assert(lstatSync(join(selectedRoot, name)).isFile());
    retain("composition-" + name, readFileSync(join(selectedRoot, name)));
  }
  const targetRoot = join(roots.root, "target-cache-fixture");
  clone("target-fixture", sourceOrigin, targetRoot, sourceRevision, sourceTree);
  copyFileSync(join(selectedRoot, "staging-package.json"), join(targetRoot, "package.json"));
  copyFileSync(targetLockPath, join(targetRoot, "pnpm-lock.yaml"));
  const targetImages = trackedImages(targetRoot, "target-before");
  assert.equal(
    command("target-manager", node26, [corepackEntrypoint, "pnpm", "--version"], targetRoot)
      .toString("utf8")
      .trim(),
    "11.20.0",
  );
  command("target-frozen-online", node26, [corepackEntrypoint, ...frozen], targetRoot);
  retainInstall(targetRoot, "target-online", 334);
  assert.deepEqual(trackedImages(targetRoot, "target-online-after"), targetImages);
  retireFixtureModules(targetRoot, "target-online");
  command(
    "target-frozen-offline",
    node26,
    [corepackEntrypoint, ...frozen, "--offline"],
    targetRoot,
    { COREPACK_ENABLE_NETWORK: "0" },
  );
  retainInstall(targetRoot, "target-offline", 334);
  assert.deepEqual(trackedImages(targetRoot, "target-offline-after"), targetImages);
  const targetPackages: Row[] = [];
  for (const [name, version] of [
    ["@agent-teams/docs-protocol", "0.6.9"],
    ["@agent-teams/docs-protocol-agent-teams", "0.8.0"],
    ["@agent-teams/engineering-foundation", "4.0.3"],
    ["typescript", "7.0.2"],
  ] as const) {
    const path = realpathSync(join(targetRoot, "node_modules", name, "package.json"));
    const manifest = json(path);
    assert.equal(manifest["name"], name);
    assert.equal(manifest["version"], version);
    targetPackages.push({ name, version, manifest: selected(path) });
  }
  record("target-fresh-offline-packages", targetPackages);
  retireFixtureModules(targetRoot, "target-offline");
  return targetLockPath;
}

export function prepareWrongManager(
  host: HostedRuntime,
  corepackEntrypoint: string,
  sourceRoot: string,
): void {
  const { node24, node26 } = host;
  const wrongManager = join(roots.root, "case-wrong-manager-corepack");
  mkdirSync(wrongManager, { mode: 0o700 });
  command(
    "wrong-manager-cache",
    node26,
    [corepackEntrypoint, "install", "--global", "pnpm@11.18.0"],
    roots.root,
    { COREPACK_HOME: wrongManager },
  );
  assert.equal(json(join(wrongManager, "lastKnownGood.json"))["pnpm"], "11.18.0");
  assert(!existsSync(join(wrongManager, "v1/pnpm/11.20.0")));
  assert.equal(
    command(
      "wrong-manager-witness",
      node24,
      [corepackEntrypoint, "pnpm", "--version"],
      sourceRoot,
      {
        COREPACK_HOME: wrongManager,
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_DEFAULT_TO_LATEST: "0",
      },
    )
      .toString("utf8")
      .trim(),
    "11.18.0",
  );
  record("wrong-manager-cache", {
    root: wrongManager,
    defaultSelection: selected(join(wrongManager, "lastKnownGood.json")),
    observedVersion: "11.18.0",
    targetManagerAbsent: true,
  });
}
