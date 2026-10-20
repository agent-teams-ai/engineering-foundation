import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPnpmRunner, runCommand, runNpmCommand } from "../scripts/pack-test-support.mjs";
import { assertRegistryOnlyInstallEvidence, verifyPublicExactDocsCoordinates } from "../scripts/public-docs-install-e2e.mjs";
import {
  documentedInstallCommands,
  installedDocumentedBinary,
  parseDocumentedQuickstart,
  previewPlanDigest,
  reviewedApplyArguments,
} from "../scripts/public-docs-quickstart.ts";
import type { PublicDocsCoordinate } from "../scripts/public-docs-quickstart.ts";

const document = await readFile(new URL("../docs/reference/open-source-docs-protocol.md", import.meta.url), "utf8");
const quickstart = parseDocumentedQuickstart(document);
const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");

test("the actual maintained quickstart selects exact npm/pnpm commands and both profiles", () => {
  assert.equal(quickstart.commands.length, 16);
  assert.deepEqual(quickstart.coordinates.map(({ name }) => name), [
    "@agent-teams/docs-protocol", "@agent-teams/docs-protocol-mcp",
  ]);
  for (const manager of ["npm", "pnpm"]) {
    assert.equal(documentedInstallCommands(quickstart, manager, false).length, 2);
    assert.equal(documentedInstallCommands(quickstart, manager, true).length, 3);
  }
});

test("unknown, ambiguous and floating documented commands are refused before execution", () => {
  const cli = quickstart.coordinates[0]!;
  for (const newline of ["\n", "\r\n"]) {
    const sourceDocument = document.replace(/\r?\n/gu, newline);
    assert.deepEqual(parseDocumentedQuickstart(sourceDocument), quickstart);
    const invalid = [
      sourceDocument.replace(/docs-protocol check\r?\n/u, "docs-protocol check; echo bypass" + newline),
      sourceDocument.replace("--max-documents 12", "--max-documents 1000"),
      sourceDocument + newline + cli.name + "@1.2.3" + newline,
      sourceDocument.replaceAll(cli.name + "@" + cli.version, cli.name + "@latest"),
      sourceDocument.replaceAll(cli.name + "@" + cli.version, cli.name + "@1.2.3-beta.1"),
    ];
    for (const source of invalid) {
      assert.notEqual(source, sourceDocument, "Each refusal fixture must change the documented input.");
      assert.throws(() => parseDocumentedQuickstart(source), /Quickstart/u);
    }
  }
});

test("only the complete digest from one human preview may replace the documented placeholder", () => {
  const digest = "sha256:" + "a".repeat(64);
  assert.equal(previewPlanDigest("Bootstrap: init (preview)\nPlan: " + digest + "\n"), digest);
  assert.throws(() => previewPlanDigest("Plan: sha256:abc\n"), /exactly one/u);
  assert.throws(() => previewPlanDigest("Plan: " + digest + "\nPlan: " + digest), /exactly one/u);
  const command = quickstart.commands.find((candidate) => candidate.includes("--apply"))!;
  assert.equal(reviewedApplyArguments(command, digest).at(-1), digest);
  assert.throws(() => reviewedApplyArguments(command, "latest"));
  assert.throws(() => reviewedApplyArguments(["docs-protocol", "check"], digest));
});

test("the documented binary must be the actual installed manifest bin", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-documented-bin-"));
  try {
    const installed = join(root, "node_modules", "@agent-teams", "docs-protocol");
    const bins = join(root, "node_modules", ".bin");
    await mkdir(join(installed, "dist"), { recursive: true });
    await mkdir(bins, { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({
      name: "@agent-teams/docs-protocol", bin: { "docs-protocol": "dist/cli.js" },
    }));
    const executable = join(installed, "dist", "cli.js");
    await writeFile(executable, "// installed executable\n");
    const binary = join(bins, "docs-protocol");
    await symlink(executable, binary);
    assert.equal(await installedDocumentedBinary(root, installed), binary);
    await rm(binary);
    await writeFile(join(root, "unexpected.js"), "// foreign executable\n");
    await symlink(join(root, "unexpected.js"), binary);
    await assert.rejects(installedDocumentedBinary(root, installed));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the real pinned pnpm shim binds and executes the installed manifest binary", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-pnpm-shim-"));
  try {
    const donor = join(root, "donor");
    const consumer = join(root, "consumer");
    await mkdir(join(donor, "dist"), { recursive: true });
    await mkdir(consumer);
    await writeFile(join(donor, "package.json"), JSON.stringify({
      name: "@agent-teams/docs-protocol", version: "0.0.0", type: "module", bin: { "docs-protocol": "dist/cli.js" },
    }));
    await writeFile(join(donor, "dist", "cli.js"), '#!/usr/bin/env node\nconsole.log("ACTUAL_INSTALLED_SHIM");\n');
    await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    await writeFile(join(consumer, "pnpm-workspace.yaml"), "packages: []\n");
    const environment: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: join(root, "npm-cache") };
    delete environment.npm_config_user_agent;
    const packed = await runNpmCommand(["pack", "--ignore-scripts", "--json"], donor, { environment });
    const tarball = (JSON.parse(packed.stdout) as { readonly filename: string }[])[0]!.filename;
    await createPnpmRunner()([
      "add", "--offline", "--save-dev", "--save-exact", "--ignore-scripts", join(donor, tarball), "--store-dir", join(root, "store"),
    ], consumer, { environment });
    const installed = await realpath(join(consumer, "node_modules", "@agent-teams", "docs-protocol"));
    const binary = await installedDocumentedBinary(consumer, installed, "pnpm");
    const result = await runCommand(binary, [], consumer);
    assert.equal(result.stdout.trim(), "ACTUAL_INSTALLED_SHIM");
    const source = await readFile(binary, "utf8");
    await writeFile(binary, source.replace(/^# cmd-shim-target=.+$/mu, "# cmd-shim-target=/foreign/cli.js"));
    await assert.rejects(installedDocumentedBinary(consumer, installed, "pnpm"));
    await writeFile(binary, source.replace('  exec node  "', '  exec foreign-node  "'));
    await assert.rejects(installedDocumentedBinary(consumer, installed, "pnpm"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("npm and pnpm native lock evidence must bind the exact observed registry SRI", () => {
  const coordinate = quickstart.coordinates[0]!;
  const artifacts = [{ ...coordinate, integrity }];
  const manifests = [{ ...coordinate, manifest: coordinate }];
  const locks = [
    { lockfileVersion: 3, packages: { ["node_modules/" + coordinate.name]: { ...coordinate, integrity } } },
    { lockfileVersion: "9.0", packages: { [coordinate.name + "@" + coordinate.version]: { resolution: { integrity } } } },
  ];
  for (const lock of locks) {
    const lockfile = JSON.stringify(lock);
    assert.doesNotThrow(() => assertRegistryOnlyInstallEvidence({ artifacts, lockfile, manifests }));
    assert.throws(() => assertRegistryOnlyInstallEvidence({
      artifacts, manifests, lockfile: lockfile.replace(integrity, "sha512-" + Buffer.alloc(64, 2).toString("base64")),
    }), /does not bind/u);
    assert.throws(() => assertRegistryOnlyInstallEvidence({
      artifacts, manifests, lockfile: lockfile.replace(integrity, "sha512-invalid"),
    }), /invalid integrity/u);
  }
});

function fixtureDependencies() {
  return {
    auditSignatures: async () => ({}),
    installAndQualify: async ({ matrixEntry }: { readonly matrixEntry: { readonly id: string } }) => ({
      root: "/policy-fixture/" + matrixEntry.id,
      userConfigPath: "/policy-fixture/" + matrixEntry.id + "/npmrc",
      documented: { binary: "/policy-fixture/bin/docs-protocol", completedCommands: 7, rejectedStalePlans: 2, manualReachability: true },
    }),
    observePublishedPackages: async (coordinates: readonly PublicDocsCoordinate[]) => Object.fromEntries(
      coordinates.map(({ name, version }) => [name, { integrity, latest: "99.0.0", versions: [version, "99.0.0"] }]),
    ),
    readPackageManifest: async () => { throw new Error("Documented mode must not derive a current source manifest version."); },
    verifyGithub: async () => null,
    verifyProvenance: () => ({ commit: "a".repeat(40) }),
  };
}

test("documented versions survive latest/source drift while the release qualification still requires latest", async () => {
  const dependencies = fixtureDependencies();
  const result = await verifyPublicExactDocsCoordinates({ temporaryRoot: "/policy-fixture", selection: "documented" }, dependencies);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.coordinates, quickstart.coordinates);
  assert.ok("documented" in result && Array.isArray(result.documented));
  assert.equal(result.documented.length, 4);
  assert.ok("artifacts" in result && Array.isArray(result.artifacts));
  assert.ok(result.artifacts.every((artifact: object) => !("latest" in artifact)));
  await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: "/policy-fixture" }, {
    ...dependencies,
    readPackageManifest: async (url: URL) => JSON.parse(await readFile(url, "utf8")),
  }), /latest dist-tag drifted/u);
});

test("a documented policy result requires all real command evidence and stable artifact identity", async () => {
  const dependencies = fixtureDependencies();
  await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: "/policy-fixture", selection: "documented" }, {
    ...dependencies,
    installAndQualify: async () => ({ root: "/policy-fixture", userConfigPath: "/policy-fixture/npmrc" }),
  }), /complete real command evidence/u);
  let observations = 0;
  await assert.rejects(verifyPublicExactDocsCoordinates({ temporaryRoot: "/policy-fixture", selection: "documented" }, {
    ...dependencies,
    observePublishedPackages: async (coordinates: readonly PublicDocsCoordinate[]) => {
      observations += 1;
      return Object.fromEntries(coordinates.map(({ name, version }) => [name, {
        integrity: "sha512-" + Buffer.alloc(64, observations).toString("base64"), latest: "99.0.0", versions: [version],
      }]));
    },
  }), /registry identity drifted/u);
});
