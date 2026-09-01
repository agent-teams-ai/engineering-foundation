import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalCallerWorkflow,
  canonicalDocsScripts,
  digestBytes
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import {
  loadPackageConsumerAssetCatalog
} from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";

export const packageRoot = join(import.meta.dirname, "..");
export const foundationRoot = join(packageRoot, "..", "engineering-foundation");
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

function restoreEnvironment(name, value) {
  if (value === undefined) { delete process.env[name]; }
  else { process.env[name] = value; }
}

export function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

export function lockfileFor(cohort) {
  const docs = cohort.packages.docsProtocol;
  const foundation = cohort.packages.engineeringFoundation;
  return `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: ${docs.version}
        version: ${docs.version}
      '@agent-teams/engineering-foundation':
        specifier: ${foundation.version}
        version: ${foundation.version}
packages:
  '@agent-teams/docs-protocol@${docs.version}':
    resolution:
      integrity: ${docs.integrity}
  '@agent-teams/engineering-foundation@${foundation.version}':
    resolution:
      integrity: ${foundation.integrity}
snapshots:
  '@agent-teams/docs-protocol@${docs.version}':
    dependencies:
      '@agent-teams/engineering-foundation': ${foundation.version}
  '@agent-teams/engineering-foundation@${foundation.version}': {}
`;
}

export function sourceManifest(cohort, profilePath) {
  return {
    name: "docs-upgrade-disposable-consumer",
    private: true,
    packageManager: "pnpm@11.20.0",
    scripts: canonicalDocsScripts(profilePath),
    devDependencies: {
      "@agent-teams/docs-protocol": cohort.packages.docsProtocol.version,
      "@agent-teams/engineering-foundation":
        cohort.packages.engineeringFoundation.version
    },
    untouched: { retained: true }
  };
}

export async function cleanupOneCommandSandbox({
  disposable,
  originalPath,
  originalDocs,
  originalFoundation,
  originalManaged,
  originalRepositoryMutation,
  restoreGitHubIdentity
}) {
  restoreEnvironment("PATH", originalPath);
  restoreEnvironment("DOCS_UPGRADE_TEST_DOCS_PACKAGE", originalDocs);
  restoreEnvironment("DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE", originalFoundation);
  restoreEnvironment("DOCS_UPGRADE_TEST_MANAGED_PACKAGE", originalManaged);
  restoreEnvironment("DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE", originalRepositoryMutation);
  restoreGitHubIdentity();
  await rm(disposable, { force: true, recursive: true });
}

export function fakeCorepackSource() {
  return `#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv[2] !== "pnpm" || process.argv[3] !== "install") {
  process.stderr.write("fake corepack accepts only pnpm install\\n");
  process.exit(64);
}
const root = process.cwd();
const profile = JSON.parse(readFileSync(join(
  root,
  "architecture/foundation/docs-consumer-integration.json"
), "utf8"));
const docs = profile.cohort.packages.docsProtocol;
const foundation = profile.cohort.packages.engineeringFoundation;
if (process.argv.includes("--no-frozen-lockfile")) {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const lockSpecifier = (name) => {
    const marker = "'" + name + "':";
    const entry = lockfile.indexOf(marker);
    const specifier = lockfile.indexOf("specifier:", entry);
    const lineEnd = lockfile.indexOf("\\n", specifier);
    if (entry < 0 || specifier < 0 || lineEnd < 0) {throw new Error("missing source lock pin");}
    return lockfile.slice(specifier + "specifier:".length, lineEnd).trim();
  };
  for (const [name, targetVersion, sourceVersion] of [
    ["@agent-teams/docs-protocol", docs.version, lockSpecifier("@agent-teams/docs-protocol")],
    ["@agent-teams/engineering-foundation", foundation.version,
      lockSpecifier("@agent-teams/engineering-foundation")]
  ]) {
    for (const version of new Set([sourceVersion, targetVersion])) {
      if (!workspace.includes(name + "@" + version)) {
        throw new Error("migration workspace omitted " + name + "@" + version);
      }
    }
  }
}
writeFileSync(join(root, "pnpm-lock.yaml"), \`lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: \${docs.version}
        version: \${docs.version}
      '@agent-teams/engineering-foundation':
        specifier: \${foundation.version}
        version: \${foundation.version}
packages:
  '@agent-teams/docs-protocol@\${docs.version}':
    resolution:
      integrity: \${docs.integrity}
  '@agent-teams/engineering-foundation@\${foundation.version}':
    resolution:
      integrity: \${foundation.integrity}
snapshots:
  '@agent-teams/docs-protocol@\${docs.version}':
    dependencies:
      '@agent-teams/engineering-foundation': \${foundation.version}
  '@agent-teams/engineering-foundation@\${foundation.version}': {}
\`);
const scope = join(root, "node_modules", "@agent-teams");
mkdirSync(scope, { recursive: true });
for (const [name, source] of [
  ["docs-protocol", process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE],
  ["engineering-foundation", process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE],
  ["docs-protocol-agent-teams", process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE],
  ["repository-mutation", process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE]
]) {
  if (typeof source !== "string" || source === "") { throw new Error("missing package path"); }
  const target = join(scope, name);
  rmSync(target, { force: true, recursive: true });
  symlinkSync(source, target, "dir");
}
`;
}

export function assertCanonicalMigrationAssets(plan, prior, target) {
  const expected = [["managed-state", "replace"]];
  if (digestBytes(prior.skill) !== target.assets.skillDigest) { expected.unshift(["skill", "replace"]); }
  if (digestBytes(prior.callerWorkflow) !== target.assets.callerWorkflowDigest) { expected.splice(expected.length - 1, 0, ["caller-workflow", "replace"]); }
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.assets.filter(({ action }) => action !== "none").map(({ id, action }) => [id, action]), expected);
}

export async function sourceCohort() {
  const [docsManifest, foundationManifest, catalog] = await Promise.all([
    readFile(join(packageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(foundationRoot, "package.json"), "utf8").then(JSON.parse),
    loadPackageConsumerAssetCatalog()
  ]);
  const provisional = {
    schemaVersion: 1,
    cohortId: "docs-source-current",
    channel: "stable",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-08-28T00:00:00Z",
    upgradeFrom: [],
    rollbackTo: [],
    packages: {
      docsProtocol: { version: docsManifest.version, integrity: INTEGRITY },
      engineeringFoundation: { version: foundationManifest.version, integrity: INTEGRITY }
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "3".repeat(40),
      blobSha: "4".repeat(40)
    },
    assets: {
      skillDigest: digestBytes(Buffer.from(await readFile(join(packageRoot, "skills/docs/SKILL.md")))),
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: catalog.catalogDigest,
      transitionCatalogDigest: catalog.transitionCatalogDigest
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: `sha256:${"5".repeat(64)}`
    }
  };
  provisional.assets.callerWorkflowDigest = digestBytes(Buffer.from(
    canonicalCallerWorkflow(provisional)
  ));
  return { cohort: provisional, catalog };
}
