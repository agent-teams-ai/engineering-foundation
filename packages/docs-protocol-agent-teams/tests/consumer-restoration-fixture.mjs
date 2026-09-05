import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { sourceCohort, sourceManifest, lockfileObjectForV2, runGit, packageRoot } from "./consumer-upgrade-e2e-fixtures.mjs";
import {
  canonicalCallerWorkflow, canonicalDocsScriptsDigest, canonicalManagedRoute,
  canonicalManagedState, describeCanonicalConsumerAssets, digestBytes
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import { computePnpmRuntimeClosureDigestV1 } from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v1.js";
import { computePnpmRuntimeClosureDigestV2 } from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";
import { createConsumerUpgradeUseCase } from "../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import { nodeConsumerIntegrationInputReader } from "../dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import { consumerIntegrationPlanningPorts } from "../dist/consumer-integration/composition/consumer-integration-planner.js";
import { foundationKnownFileTransaction } from "../dist/consumer-integration/adapters/foundation-known-file-transaction.js";
import { NodeConsumerUpgradeSandbox } from "../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";
import { finalizeNodeConsumerRestoration } from "../dist/consumer-integration/adapters/node-consumer-restoration-finalization.js";
import { consumerRestorationRecorder, restoreNodeConsumerIntegration } from "../dist/consumer-integration/adapters/node-consumer-restoration.js";

export async function fixtureProcess(executable, args, cwd) {
  return new Promise((resolve, reject) => {execFile(executable, args, {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024
  }, (error, stdout, stderr) => { if (error === null) {resolve(stdout);} else {reject(new Error(`${executable}: ${stderr || stdout}`, { cause: error }));} });});
}

async function fixturePackage(parent, name, version, dependencies, cli) {
  const directory = join(parent, name.replaceAll("/", "-"), version);
  await mkdir(join(directory, "package", "dist"), { recursive: true });
  const manifest = { name, version, dependencies, type: "module" };
  await writeFile(join(directory, "package", "package.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "package", "dist", "cli.js"), cli ?? "export {};\n");
  // A lifecycle script must never execute in either generation's installation.
  manifest.scripts = { postinstall: "node -e \"process.exit(99)\"" };
  await writeFile(join(directory, "package", "package.json"), JSON.stringify(manifest));
  const tarball = join(directory, "fixture.tgz");
  await fixtureProcess("tar", ["-czf", tarball, "package"], directory);
  const bytes = await readFile(tarball);
  return { manifest, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

async function fixtureRegistry(packages) {
  let base;
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1);
    const tar = packages.find(({ manifest }) => path === `${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz`);
    if (tar) {response.end(tar.bytes); return;}
    const matches = packages.filter(({ manifest }) => manifest.name === path);
    if (matches.length === 0) {response.writeHead(404); response.end(); return;}
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ name: path, "dist-tags": { latest: matches.at(-1).manifest.version },
      time: Object.fromEntries(matches.map(({ manifest }) => [manifest.version, "2026-01-01T00:00:00Z"])),
      versions: Object.fromEntries(matches.map(({ manifest, integrity }) => [manifest.version, {
        ...manifest, dist: { integrity, tarball: `${base}/${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz` }
      }])) }));
  });
  await new Promise((resolve) => {server.listen(0, "127.0.0.1", resolve);});
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => {server.close(resolve);}) };
}

const projection = (cohort) => ({ repository: "agent-teams-ai/.github", path: "governance/docs-qualified-cohorts.json", revision: "8".repeat(40), cohort });

export async function managedRestorationFixture({ cohortV2, desired, preserveForeign = false }) {
  const disposable = await mkdtemp(join(tmpdir(), "managed-restoration-TEST-"));
  const consumerRoot = join(disposable, "consumer");
  await mkdir(consumerRoot);
  const saved = new Map();
  function setEnv(key, value) {saved.set(key, process.env[key]); process.env[key] = value;}
  let registry;
  try {
    const { catalog } = await sourceCohort();
    const historical = catalog.directTargetBundles.find(({ cohort }) => cohort.cohortId === "docs-2026-08-31-stable10");
    const origin = structuredClone(historical.cohort);
    const docsName = "@agent-teams/docs-protocol";
    const foundationName = "@agent-teams/engineering-foundation";
    const oldCli = `import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root=process.cwd();
assert.deepEqual(process.argv.slice(2),['consumer','check','--consumer',root,'--json']);
assert.equal(JSON.parse(readFileSync(join(root,'architecture/foundation/docs-consumer-integration.json'))).schemaVersion,2);
assert.equal(existsSync(join(root,'node_modules/@agent-teams/docs-protocol-agent-teams')),false);
console.log(JSON.stringify({outcome:'current',fixtureCli:'historical-v1'}));
if(process.env.MANAGED_RESTORATION_TEST_FAIL==='1') process.exitCode=1;\n`;
    const packages = [
      await fixturePackage(disposable, foundationName, origin.packages.engineeringFoundation.version, {}),
      await fixturePackage(disposable, docsName, origin.packages.docsProtocol.version,
        { [foundationName]: origin.packages.engineeringFoundation.version }, oldCli)
    ];
    origin.packages.engineeringFoundation.integrity = packages[0].integrity;
    origin.packages.docsProtocol.integrity = packages[1].integrity;
    const target = cohortV2("docs-restoration-test-v2", { upgradeFrom: [origin.cohortId], rollbackTo: [origin.cohortId], version: "99.0.0" });
    const names = {
      repositoryMutation: "@agent-teams/repository-mutation", documentAuthoring: "@agent-teams/document-authoring",
      docsProtocol: docsName, docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams", engineeringFoundation: foundationName
    };
    const snapshots = lockfileObjectForV2(target).snapshots;
    const managedCli = `// TEST fixture delegates to the retained implementation, not a published package claim.\nimport {runManagedConsumerCommand} from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/consumer-integration/composition/consumer-integration-cli.js")).href)};\nprocess.exitCode=await runManagedConsumerCommand(process.argv.slice(2));\nif(process.argv[2]==='check' && process.env.MANAGED_RESTORATION_TARGET_FAIL==='1') process.exitCode=1;\n`;
    for (const [key, name] of Object.entries(names)) {
      const pkg = await fixturePackage(disposable, name, "99.0.0", snapshots[`${name}@99.0.0`].dependencies ?? {},
        key === "docsProtocolAgentTeams" ? managedCli : undefined);
      packages.push(pkg);
      target.packages[key].integrity = pkg.integrity;
    }
    if (preserveForeign) {packages.push(await fixturePackage(disposable, "consumer-test-tool", "1.0.0", {}));}
    target.assets = describeCanonicalConsumerAssets(target);
    target.runtime.runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(lockfileObjectForV2(target), target);
    registry = await fixtureRegistry(packages);
    setEnv("npm_config_registry", registry.base);
    setEnv("pnpm_config_registry", registry.base);
    const store = process.env.npm_config_store_dir ?? join(disposable, "store");
    setEnv("npm_config_store_dir", store);
    setEnv("pnpm_config_store_dir", store);
    setEnv("CI", "true");
    const current = desired(origin, 2);
    setEnv("GITHUB_REPOSITORY_ID", current.repository.id);
    setEnv("GITHUB_REPOSITORY", current.repository.nameWithOwner);
    const profilePath = "architecture/foundation/docs-consumer-integration.json";
    async function write(path, bytes) {await mkdir(dirname(join(consumerRoot, path)), { recursive: true }); await writeFile(join(consumerRoot, path), bytes);}
    const manifest = structuredClone(sourceManifest(origin, current.profilePath));
    if (preserveForeign) {
      manifest.description = "Consumer-owned description";
      manifest.scripts["consumer:custom"] = "node local-check.mjs";
      manifest.devDependencies["consumer-test-tool"] = "1.0.0";
    }
    await write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    await write(".node-version", "24.18.0\n");
    await write(".gitignore", "node_modules/\n");
    await write("pnpm-workspace.yaml", `packages: []\npackageImportMethod: copy\nminimumReleaseAgeExclude:\n  - "${docsName}@${origin.packages.docsProtocol.version}"\n  - "${foundationName}@${origin.packages.engineeringFoundation.version}"\n`);
    // Real Corepack honors the manifest pin; no test corepack executable or PATH rewrite.
    const pnpmVersion = (await fixtureProcess("corepack", ["pnpm", "--version"], consumerRoot)).trim();
    assert.equal(pnpmVersion, "11.20.0");
    await fixtureProcess("corepack", ["pnpm", "install", "--ignore-scripts", "--ignore-pnpmfile", "--verify-store-integrity"], consumerRoot);
    origin.runtime.runtimeClosureDigest = computePnpmRuntimeClosureDigestV1(parseYaml(await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8")), origin);
    origin.assets.callerWorkflowDigest = digestBytes(Buffer.from(canonicalCallerWorkflow(origin)));
    const route = Buffer.from(canonicalManagedRoute(current.skillPath));
    const caller = Buffer.from(canonicalCallerWorkflow(origin));
    await write(profilePath, `${JSON.stringify(current, null, 2)}\n`);
    await write("AGENTS.md", preserveForeign ? Buffer.concat([Buffer.from("Consumer policy before the managed route.\n\n"), route, Buffer.from("\nConsumer policy after the route.\n")]) : route);
    await write(current.skillPath, historical.skill);
    await write(current.callerWorkflowPath, caller);
    await write(current.managedStatePath, canonicalManagedState(current, {
      skillDigest: digestBytes(historical.skill), callerWorkflowDigest: digestBytes(caller),
      assetCatalogDigest: origin.assets.assetCatalogDigest, transitionCatalogDigest: origin.assets.transitionCatalogDigest,
      agentsRouteDigest: digestBytes(route), docsScriptsDigest: canonicalDocsScriptsDigest(current.profilePath)
    }));
    await write("README.md", "Unrelated consumer content must survive.\n");
    await chmod(join(consumerRoot, current.skillPath), 0o755);
    runGit(consumerRoot, ["init", "-q"]);
    runGit(consumerRoot, ["config", "user.email", "test@example.invalid"]);
    runGit(consumerRoot, ["config", "user.name", "Restoration TEST fixture"]);
    runGit(consumerRoot, ["add", "--all"]);
    runGit(consumerRoot, ["commit", "-qm", "test: seed historical disposable consumer"]);
    const sourceRevision = runGit(consumerRoot, ["rev-parse", "HEAD"]);
    const oldCheck = async () => JSON.parse(await fixtureProcess(process.execPath,
      [join(consumerRoot, "node_modules/@agent-teams/docs-protocol/dist/cli.js"), "consumer", "check", "--consumer", consumerRoot, "--json"], consumerRoot));
    assert.equal((await oldCheck()).fixtureCli, "historical-v1");
    const fixtureCatalog = { ...catalog, directTargetBundles: [{ ...historical, cohort: origin, callerWorkflow: caller },
      ...catalog.directTargetBundles.filter(({ cohort }) => cohort.cohortId !== origin.cohortId)] };
    const authority = { read: async () => projection(target), readRestoration: async () => ({ source: projection(target), target: projection(origin) }) };
    const sandbox = new NodeConsumerUpgradeSandbox();
    const prepare = createConsumerUpgradeUseCase({
      assets: { read: async () => fixtureCatalog }, authority,
      restoration: consumerRestorationRecorder(authority), input: nodeConsumerIntegrationInputReader,
      planning: consumerIntegrationPlanningPorts, sandbox, transaction: foundationKnownFileTransaction
    });
    const proofPath = join(disposable, "restoration.json");
    const upgradeOptions = { consumerRoot, targetGeneration: 2, sourceGeneration: 1, to: target.cohortId, restorationProofPath: proofPath, prepare: true };
    const finalizeOptions = { consumerRoot, sourceGeneration: 1, targetGeneration: 2, from: origin.cohortId, to: target.cohortId, proofPath, preparationPath: `${proofPath}.prepared` };
    const finalize = (options, overrides = {}) => finalizeNodeConsumerRestoration({ ...finalizeOptions, ...options }, { authority, sandbox, ...overrides });
    const upgrade = async (options) => {
      const result = await prepare(options);
      if (result.outcome !== "prepared") {return result;}
      return finalize({ expect: result.preparation.digest, preparationPath: result.preparation.path, proofPath: options.restorationProofPath });
    };
    const restoreOptions = { consumerRoot, sourceGeneration: 2, targetGeneration: 1, from: target.cohortId, to: origin.cohortId, proofPath };
    return {
      disposable, consumerRoot, current, origin, target, authority, sandbox, upgrade, upgradeOptions, prepare, finalize, finalizeOptions, fixtureCatalog,
      restoreOptions, proofPath, sourceRevision, pnpmVersion, oldCheck,
      restore: (options, overrides = {}) => restoreNodeConsumerIntegration({ ...restoreOptions, ...options }, { authority, sandbox, ...overrides }),
      close: async () => {
        for (const [key, value] of saved) {if (value === undefined) {delete process.env[key];} else {process.env[key] = value;}}
        if (process.env.MANAGED_RESTORATION_EVIDENCE_DIR) {
          await cp(disposable, join(process.env.MANAGED_RESTORATION_EVIDENCE_DIR, basename(disposable)), {
            recursive: true, filter: (path) => !path.split("/").some((part) => ["node_modules", ".git", ".agent-teams-local"].includes(part))
          });
        }
        await registry.close(); await rm(disposable, { recursive: true, force: true });
      }
    };
  } catch (error) {
    for (const [key, value] of saved) {if (value === undefined) {delete process.env[key];} else {process.env[key] = value;}}
    await registry?.close(); await rm(disposable, { recursive: true, force: true }); throw error;
  }
}
