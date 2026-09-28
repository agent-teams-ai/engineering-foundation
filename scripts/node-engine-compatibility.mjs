import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function assertNodeLane(version, policy) {
  const major = Number(version.split(".")[0]);
  const lane = [policy.runtime.productionDefault, policy.runtime.compatibilityLane]
    .find((candidate) => candidate.nodeMajor === major);
  if (lane?.qualificationVersion !== version) {
    throw new Error(`Node compatibility qualification requires the policy-qualified Node version, received ${version}.`);
  }
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function packPackage(packageEntry, destination) {
  const before = new Set(await readdir(destination));
  await execFileAsync("pnpm", ["--filter", packageEntry.name, "pack", "--pack-destination", destination], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_engine_strict: "true" },
  });
  const created = (await readdir(destination)).filter((name) => name.endsWith(".tgz") && !before.has(name));
  if (created.length !== 1) {
    throw new Error(`${packageEntry.name} produced ${created.length} archives instead of exactly one.`);
  }
  return join(destination, created[0]);
}

async function installedManifest(consumerRoot, packageName) {
  const requireFromConsumer = createRequire(join(consumerRoot, "qualification.mjs"));
  return readManifest(requireFromConsumer.resolve(`${packageName}/package.json`));
}

export async function importInstalledQualification(consumerRoot) {
  const bridge = join(consumerRoot, "qualification.mjs");
  await writeFile(bridge,
    "export { runDocsProtocolQualification } from '@agent-teams/docs-protocol/qualification';\n");
  return import(pathToFileURL(bridge).href);
}

async function runPortableQualification(qualification, temporaryRoot) {
  const fixtureRoot = join(temporaryRoot, "portable-qualification-fixture");
  await cp(
    join(repositoryRoot, "packages", "docs-protocol", "tests", "fixtures", "portable-qualification"),
    fixtureRoot,
    { recursive: true, errorOnExist: true, force: false }
  );
  const receipt = await qualification.runDocsProtocolQualification({
    fixtureRoot,
    scenario: {
      find: { query: { type: "adr" }, expectedIds: [] },
      newDocument: {
        intent: {
          type: "adr",
          id: "ADR-0001",
          title: "Node engine compatibility qualification",
          owner: "architecture/tooling",
          summary: "Proves the installed portable qualification on a disposable fixture."
        }
      }
    }
  });
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.projectId, "docs-protocol-qualification");
  assert.equal(receipt.appliedDocumentPath, "docs/decisions/generated/0001-node-engine-compatibility-qualification.md");
  assert.deepEqual(receipt.checks, [
    "info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent",
    "apply", "index", "check", "source-unchanged"
  ]);
  return receipt;
}

export async function qualifyNodeEngineCompatibility() {
  const nodeVersion = process.versions.node;
  const policy = await readManifest(join(repositoryRoot, "architecture", "foundation", "docs-protocol-current-policy.json"));
  assertNodeLane(nodeVersion, policy);
  const rootManifest = await readManifest(join(repositoryRoot, "package.json"));
  const packageEngine = policy.runtime.packageEngine;
  if (rootManifest.engines?.node !== packageEngine) {
    throw new Error(`Repository engine policy changed unexpectedly: ${packageEngine ?? "missing"}.`);
  }
  for (const entry of PUBLISHABLE_PACKAGES) {
    const manifest = await readManifest(join(repositoryRoot, entry.manifestPath));
    if (manifest.engines?.node !== packageEngine) {
      throw new Error(`${entry.name} does not carry the exact Node compatibility engine range.`);
    }
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "foundation-node-engine-"));
  const archiveRoot = join(temporaryRoot, "archives");
  const consumerRoot = join(temporaryRoot, "consumer");
  try {
    await mkdir(archiveRoot, { recursive: true });
    await mkdir(consumerRoot, { recursive: true });
    const archives = [];
    for (const entry of PUBLISHABLE_PACKAGES) {
      archives.push(await packPackage(entry, archiveRoot));
    }
    await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
      name: "foundation-node-engine-qualification",
      version: "0.0.0",
      private: true,
      type: "module",
      engines: rootManifest.engines,
    }, null, 2)}\n`);
    await writeFile(join(consumerRoot, ".npmrc"), "engine-strict=true\nignore-scripts=true\n");
    await execFileAsync("npm", [
      "install",
      "--engine-strict",
      "--ignore-scripts",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      ...archives,
    ], { cwd: consumerRoot, env: { ...process.env, npm_config_engine_strict: "true" } });

    const qualification = await importInstalledQualification(consumerRoot);
    if (typeof qualification.runDocsProtocolQualification !== "function") {
      throw new Error("Installed Docs Protocol qualification entrypoint is unavailable.");
    }
    const portableReceipt = await runPortableQualification(qualification, temporaryRoot);
    const installed = [];
    for (const entry of PUBLISHABLE_PACKAGES) {
      const manifest = await installedManifest(consumerRoot, entry.name);
      if (manifest.engines?.node !== packageEngine) {
        throw new Error(`Installed ${entry.name} lost the exact Node compatibility engine range.`);
      }
      installed.push({ name: manifest.name, version: manifest.version, nodeEngine: manifest.engines.node });
    }
    return {
      schemaVersion: 1,
      outcome: "passed",
      nodeVersion,
      packageEngine,
      installMode: "fresh-consumer-engine-strict",
      qualificationEntry: "@agent-teams/docs-protocol/qualification#runDocsProtocolQualification",
      portableQualification: {
        outcome: "passed",
        fixtureMode: "disposable-copy",
        projectId: portableReceipt.projectId,
        appliedDocumentPath: portableReceipt.appliedDocumentPath,
        checks: portableReceipt.checks
      },
      packages: installed,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await qualifyNodeEngineCompatibility(), null, 2)}\n`);
}
