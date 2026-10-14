import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
export const documentAuthoringRoot = join(packageRoot, "..", "document-authoring");
export const repositoryMutationRoot = join(packageRoot, "..", "repository-mutation");
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

export function lockfileObjectForV2(cohort) {
  const packages = {
    "@agent-teams/repository-mutation": cohort.packages.repositoryMutation,
    "@agent-teams/document-authoring": cohort.packages.documentAuthoring,
    "@agent-teams/docs-protocol": cohort.packages.docsProtocol,
    "@agent-teams/docs-protocol-agent-teams": cohort.packages.docsProtocolAgentTeams,
    "@agent-teams/engineering-foundation": cohort.packages.engineeringFoundation
  };
  const entry = (name) => ({
    specifier: packages[name].version,
    version: packages[name].version
  });
  const locator = (name) => `${name}@${packages[name].version}`;
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { ".": { devDependencies: {
      "@agent-teams/docs-protocol": entry("@agent-teams/docs-protocol"),
      "@agent-teams/docs-protocol-agent-teams":
        entry("@agent-teams/docs-protocol-agent-teams"),
      "@agent-teams/engineering-foundation": entry("@agent-teams/engineering-foundation")
    } } },
    packages: Object.fromEntries(Object.entries(packages).map(([name, coordinate]) => [
      locator(name),
      { resolution: { integrity: coordinate.integrity } }
    ])),
    snapshots: {
      [locator("@agent-teams/repository-mutation")]: {},
      [locator("@agent-teams/document-authoring")]: {
        dependencies: {
          "@agent-teams/repository-mutation": packages["@agent-teams/repository-mutation"].version
        }
      },
      [locator("@agent-teams/docs-protocol")]: {
        dependencies: {
          "@agent-teams/document-authoring": packages["@agent-teams/document-authoring"].version,
          "@agent-teams/repository-mutation": packages["@agent-teams/repository-mutation"].version
        }
      },
      [locator("@agent-teams/docs-protocol-agent-teams")]: {
        dependencies: {
          "@agent-teams/docs-protocol": packages["@agent-teams/docs-protocol"].version,
          "@agent-teams/repository-mutation": packages["@agent-teams/repository-mutation"].version
        }
      },
      [locator("@agent-teams/engineering-foundation")]: {
        dependencies: {
          "@agent-teams/document-authoring": packages["@agent-teams/document-authoring"].version,
          "@agent-teams/repository-mutation": packages["@agent-teams/repository-mutation"].version
        }
      }
    }
  };
}

export function lockfileForV2(cohort) {
  return `${JSON.stringify(lockfileObjectForV2(cohort), null, 2)}\n`;
}

export function sourceManifestV2(cohort, profilePath) {
  return {
    name: "docs-upgrade-v2-disposable-consumer",
    private: true,
    packageManager: "pnpm@11.20.0",
    scripts: canonicalDocsScripts(profilePath),
    devDependencies: {
      "@agent-teams/docs-protocol": cohort.packages.docsProtocol.version,
      "@agent-teams/docs-protocol-agent-teams": cohort.packages.docsProtocolAgentTeams.version,
      "@agent-teams/engineering-foundation": cohort.packages.engineeringFoundation.version
    },
    untouched: { retained: true }
  };
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

function canonicalJson(value) {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function registryDigest(value, field, domain) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  return `sha256:${createHash("sha256").update(canonicalJson({ domain, body })).digest("hex")}`;
}

const V3_PACKAGES = {
  repositoryMutation: ["@agent-teams/repository-mutation", "transitive"],
  documentAuthoring: ["@agent-teams/document-authoring", "transitive"],
  docsProtocol: ["@agent-teams/docs-protocol", "direct"],
  docsProtocolAgentTeams: ["@agent-teams/docs-protocol-agent-teams", "direct"],
  engineeringFoundation: ["@agent-teams/engineering-foundation", "direct"]
};
const V3_EDGES = [
  ["@agent-teams/document-authoring", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol", "@agent-teams/document-authoring"],
  ["@agent-teams/docs-protocol", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/docs-protocol"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/repository-mutation"],
  ["@agent-teams/engineering-foundation", "@agent-teams/document-authoring"],
  ["@agent-teams/engineering-foundation", "@agent-teams/repository-mutation"]
];
function v3Provenance(name, version) {
  return {
    source_repository: "agent-teams-ai/engineering-foundation",
    source_repository_id: 1316243988,
    source_workflow: "scripts/release-publish.mjs",
    source_commit: "a".repeat(40),
    workflow_run_id: 1,
    workflow_run_attempt: 1,
    registry_attestation_url: `https://registry.npmjs.org/-/npm/v1/attestations/${name.replaceAll("/", "%2f")}@${version}`,
    workflow_run_url: "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/1",
    signature_verified: true
  };
}
function v3Asset(path, digest, renderedDigest) {
  const asset = { package: "@agent-teams/docs-protocol-agent-teams", path, digest };
  return renderedDigest === undefined ? asset : { ...asset, rendered_digest: renderedDigest };
}
export function cohortV3Registry({
  cohort, repository, lifecycleState = "CANARY",
  canaryRepositoryIds = [repository.id], revision = "8".repeat(40)
}) {
  const packageEntry = ([key, coordinate]) => {
    const [name, role] = V3_PACKAGES[key];
    return { name, role, version: coordinate.version, integrity: coordinate.integrity,
      registry: "https://registry.npmjs.org/", published_at: "2026-10-14T00:00:00Z",
      provenance: v3Provenance(name, coordinate.version) };
  };
  const event = (sequence, state, effectiveAt, previousEventDigest, canaryEvidence) => {
    const value = { sequence, cohort_id: cohort.cohortId, state, effective_at: effectiveAt,
      support_until: null, evidence_references: [`https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${sequence}`],
      canary_evidence: canaryEvidence, previous_event_digest: previousEventDigest };
    value.event_digest = registryDigest(value, "event_digest", "agent-teams.docs-qualified-cohort-event/v1");
    return value;
  };
  const source = {
    cohort_generation: 3, cohort_id: cohort.cohortId, channel: cohort.channel,
    candidate_digest: cohort.candidateDigest,
    policy_identity: cohort.runtime.policy,
    packages: Object.entries(cohort.packages).map(packageEntry),
    dependency_edges: V3_EDGES.map(([from, to]) => ({ from, to })),
    reusable_workflow: {
      repository: cohort.workflow.repository, repository_id: 1316243981,
      path: cohort.workflow.path, revision: cohort.workflow.revision, blob_sha: cohort.workflow.blobSha
    },
    schemas: { consumer_integration: 4, managed_state: 3, qualification_receipt: 1,
      docs_protocol: 1, foundation_plan: 1, foundation_journal: 1, foundation_receipt: 1,
      foundation_envelope: 5 },
    assets: {
      skill: v3Asset("skills/docs/SKILL.md", cohort.assets.skillDigest),
      caller_workflow: v3Asset("assets/docs-protocol.yml", cohort.assets.callerWorkflowDigest,
        cohort.assets.callerWorkflowDigest),
      asset_catalog: v3Asset("assets/catalog.json", cohort.assets.assetCatalogDigest),
      transition_catalog: v3Asset("assets/transition-catalog.json", cohort.assets.transitionCatalogDigest)
    },
    runtime: { selected_lane: cohort.runtime.selectedLane, node: cohort.runtime.node,
      pnpm: cohort.runtime.pnpm,
      qualification_runtime: { node_version: cohort.runtime.qualificationRuntime.nodeVersion,
        pnpm_version: cohort.runtime.qualificationRuntime.pnpmVersion,
        platform: cohort.runtime.qualificationRuntime.platform,
        architecture: cohort.runtime.qualificationRuntime.architecture } },
    runtime_closure: { schema_version: 2, domain: cohort.runtime.runtimeClosure.domain,
      package_manager: "pnpm@11.20.0", lockfile_version: "9.0", package_count: 5,
      projection_path: `governance/docs-runtime-closures/${cohort.runtime.runtimeClosure.digest.replace(":", "-")}.json`,
      digest: cohort.runtime.runtimeClosure.digest },
    eligible_after: cohort.eligibleAfter, upgrade_from: cohort.upgradeFrom,
    rollback_to: cohort.rollbackTo,
    canary_repositories: canaryRepositoryIds.map((id) => ({ repository_id: Number(id),
      repository: id === repository.id ? repository.nameWithOwner : "agent-teams-ai/other-consumer" })),
    evidence_references: ["https://github.com/agent-teams-ai/engineering-foundation/actions/runs/1"]
  };
  source.record_digest = registryDigest(source, "record_digest", "agent-teams.docs-qualified-cohort/v3");
  const qualified = event(1, "QUALIFIED", "2026-10-14T00:00:00Z", null, []);
  const selectedRepository = canaryRepositoryIds[0] === repository.id;
  const canaryEvidence = lifecycleState === "CANARY" ? [{
    repository_id: Number(canaryRepositoryIds[0]),
    repository: selectedRepository ? repository.nameWithOwner : "agent-teams-ai/other-consumer",
    merge_revision: "a".repeat(40), observed_cohort_id: cohort.cohortId,
    observed_record_digest: source.record_digest, observed_event_digest: qualified.event_digest,
    required_context: "Docs Protocol", integration_id: 1, conclusion: "success",
    check_run_id: 22,
    check_run_url: `https://github.com/agent-teams-ai/${selectedRepository ? repository.nameWithOwner.split("/")[1] : "other-consumer"}/actions/runs/33/job/22`,
    workflow_run_id: 33, workflow_id: 4,
    caller_workflow_path: ".github/workflows/docs-protocol.yml",
    caller_workflow_digest: cohort.assets.callerWorkflowDigest
  }] : [];
  return { schema_version: 1, cohorts: [source], events: [
    qualified, event(2, lifecycleState, "2026-10-14T00:01:00Z", qualified.event_digest, canaryEvidence)
  ], revision };
}
export function rebindCohortV3Registry(registry) {
  const source = registry.cohorts[0];
  const sourceBody = { ...source };
  delete sourceBody.record_digest;
  source.record_digest = registryDigest(
    sourceBody, "record_digest", "agent-teams.docs-qualified-cohort/v3"
  );
  let previous = null;
  let qualifiedDigest;
  for (const event of registry.events) {
    event.previous_event_digest = previous;
    for (const evidence of event.canary_evidence) {
      evidence.observed_record_digest = source.record_digest;
      if (qualifiedDigest !== undefined) {evidence.observed_event_digest = qualifiedDigest;}
    }
    delete event.event_digest;
    event.event_digest = registryDigest(
      event, "event_digest", "agent-teams.docs-qualified-cohort-event/v1"
    );
    previous = event.event_digest;
    if (event.state === "QUALIFIED") {qualifiedDigest = event.event_digest;}
  }
  return registry;
}
export async function cleanupOneCommandSandbox({
  disposable,
  originalPath,
  originalDocs,
  originalFoundation,
  originalManaged,
  originalDocumentAuthoring,
  originalRepositoryMutation,
  restoreGitHubIdentity
}) {
  restoreEnvironment("PATH", originalPath);
  restoreEnvironment("DOCS_UPGRADE_TEST_DOCS_PACKAGE", originalDocs);
  restoreEnvironment("DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE", originalFoundation);
  restoreEnvironment("DOCS_UPGRADE_TEST_MANAGED_PACKAGE", originalManaged);
  restoreEnvironment("DOCS_UPGRADE_TEST_DOCUMENT_AUTHORING_PACKAGE", originalDocumentAuthoring);
  restoreEnvironment("DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE", originalRepositoryMutation);
  restoreGitHubIdentity();
  await rm(disposable, { force: true, recursive: true });
}

export function historicalDocsCheckFixtureSource() {
  return `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const args = process.argv.slice(2);
assert.deepEqual(args, ["consumer", "check", "--consumer", root, "--json"]);
assert.equal(fs.existsSync(path.join(root, "node_modules/@agent-teams/docs-protocol-agent-teams")), false);
const profile = JSON.parse(fs.readFileSync(path.join(root,
  "architecture/foundation/docs-consumer-integration.json"), "utf8"));
assert.equal(profile.cohort.schemaVersion, 1);
assert.ok(profile.schemaVersion === 1 || profile.schemaVersion === 2);
fs.writeFileSync(path.join(__dirname, "../last-check.json"), JSON.stringify({
  schemaVersion: profile.schemaVersion, cohortId: profile.cohort.cohortId, args
}));
process.stdout.write(JSON.stringify({ outcome: "current" }));
`;
}

export function fakeCorepackSource(historicalDocsRoot) {
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
  const isV2 = profile.cohort.schemaVersion === 2 || profile.cohort.schemaVersion === 3;
const historicalDocsSource = ${JSON.stringify(historicalDocsRoot ?? null)};
if (process.argv.includes("--no-frozen-lockfile") && !isV2) {
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
if (isV2) {
  const coordinates = {
    "@agent-teams/repository-mutation": profile.cohort.packages.repositoryMutation,
    "@agent-teams/document-authoring": profile.cohort.packages.documentAuthoring,
    "@agent-teams/docs-protocol": docs,
    "@agent-teams/docs-protocol-agent-teams": profile.cohort.packages.docsProtocolAgentTeams,
    "@agent-teams/engineering-foundation": foundation
  };
  if (process.argv.includes("--no-frozen-lockfile")) {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    for (const [name, coordinate] of Object.entries(coordinates)) {
      if (!workspace.includes(name + "@" + coordinate.version)) {
        throw new Error("migration workspace omitted " + name + "@" + coordinate.version);
      }
    }
  }
  const entry = (name) => ({
    specifier: coordinates[name].version,
    version: coordinates[name].version
  });
  const locator = (name) => name + "@" + coordinates[name].version;
  const lock = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { ".": { devDependencies: {
      "@agent-teams/docs-protocol": entry("@agent-teams/docs-protocol"),
      "@agent-teams/docs-protocol-agent-teams": entry("@agent-teams/docs-protocol-agent-teams"),
      "@agent-teams/engineering-foundation": entry("@agent-teams/engineering-foundation")
    } } },
    packages: Object.fromEntries(Object.entries(coordinates).map(([name, coordinate]) => [
      locator(name), { resolution: { integrity: coordinate.integrity } }
    ])),
    snapshots: {
      [locator("@agent-teams/repository-mutation")]: {},
      [locator("@agent-teams/document-authoring")]: { dependencies: {
        "@agent-teams/repository-mutation": coordinates["@agent-teams/repository-mutation"].version
      } },
      [locator("@agent-teams/docs-protocol")]: { dependencies: {
        "@agent-teams/document-authoring": coordinates["@agent-teams/document-authoring"].version,
        "@agent-teams/repository-mutation": coordinates["@agent-teams/repository-mutation"].version
      } },
      [locator("@agent-teams/docs-protocol-agent-teams")]: { dependencies: {
        "@agent-teams/docs-protocol": coordinates["@agent-teams/docs-protocol"].version,
        "@agent-teams/repository-mutation": coordinates["@agent-teams/repository-mutation"].version
      } },
      [locator("@agent-teams/engineering-foundation")]: { dependencies: {
        "@agent-teams/document-authoring": coordinates["@agent-teams/document-authoring"].version,
        "@agent-teams/repository-mutation": coordinates["@agent-teams/repository-mutation"].version
      } }
    }
  };
  writeFileSync(join(root, "pnpm-lock.yaml"), JSON.stringify(lock, null, 2) + "\\n");
} else {
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
}
const scope = join(root, "node_modules", "@agent-teams");
mkdirSync(scope, { recursive: true });
if (!isV2) {
  for (const name of ["docs-protocol-agent-teams", "repository-mutation", "document-authoring"]) {
    rmSync(join(scope, name), { force: true, recursive: true });
  }
}
const packageSources = [
  ["docs-protocol", isV2 ? process.env.DOCS_UPGRADE_TEST_DOCS_PACKAGE : historicalDocsSource],
  ["engineering-foundation", process.env.DOCS_UPGRADE_TEST_FOUNDATION_PACKAGE]
];
if (isV2) {
  packageSources.push(
    ["docs-protocol-agent-teams", process.env.DOCS_UPGRADE_TEST_MANAGED_PACKAGE],
    ["repository-mutation", process.env.DOCS_UPGRADE_TEST_REPOSITORY_MUTATION_PACKAGE],
    ["document-authoring", process.env.DOCS_UPGRADE_TEST_DOCUMENT_AUTHORING_PACKAGE]
  );
}
for (const [name, source] of packageSources) {
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
