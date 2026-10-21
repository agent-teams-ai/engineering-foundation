import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
import { resolveQualificationExecutables } from "../tools/executable-policy.mts";

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

function packagingObservations(stdout: string) {
  return stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("PACKAGING_PNPM_TEST:"))
    .map((line) => JSON.parse(line.slice("PACKAGING_PNPM_TEST:".length)) as {
      readonly commonJs: string; readonly esm: string; readonly node: string; readonly nodeExecutable: string;
      readonly nodePath: string | null; readonly nodeOptions: string | null; readonly sentinel?: string;
    });
}

async function runPackagingFixtureCommand(phase: string, execute: () => ReturnType<typeof runCommand>) {
  try {
    return await execute();
  } catch (error) {
    const failure = error as { readonly stderr?: unknown; readonly stdout?: unknown; readonly code?: unknown };
    const output = [failure.stderr, failure.stdout]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    // The mandatory runner bounds error messages to 48 characters. Keep the
    // child failure's meaningful suffix visible and retain the full cause.
    throw new Error(`${output?.slice(-48) || "no child output"} (pnpm ${phase}, exit ${String(failure.code)})`, { cause: error });
  }
}

test("nested pnpm scripts keep packaged consumers isolated from the owner workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "packaging-pnpm-isolation-"));
  try {
    const owner = join(root, "owner");
    const consumer = join(root, "consumer");
    const ambient = join(owner, "packages", "ambient");
    await Promise.all([owner, consumer, ambient].map((path) => mkdir(path, { recursive: true })));
    const { node } = await resolveQualificationExecutables("node");
    const managerRoot = dirname(fileURLToPath(import.meta.resolve("pnpm")));
    const manager = JSON.parse(await readFile(join(managerRoot, "package.json"), "utf8")) as {
      readonly name: string; readonly version: string; readonly bin: { readonly pnpm: string };
    };
    assert.equal(manager.name, "pnpm");
    assert.equal(manager.version, "11.20.0");
    const entry = join(managerRoot, manager.bin.pnpm);
    const environment: NodeJS.ProcessEnv = { ...process.env };
    // A plain copy of Windows process.env can retain Path beside a new PATH.
    // The managed launcher correctly rejects case-insensitive duplicate names.
    const replacedNames = new Set(["path", "node_path", "node_options", "npm_config_cache", "npm_config_user_agent"]);
    for (const key of Object.keys(environment)) {
      if (replacedNames.has(key.toLowerCase())) { delete environment[key]; }
    }
    environment.PATH = [dirname(node), process.env.PATH].filter(Boolean).join(delimiter);
    environment.npm_config_cache = join(root, "npm-cache");
    // A file: directory install strips every nested node_modules directory,
    // including pnpm's real bundled native dependencies on Windows and Darwin.
    const packed = await runPackagingFixtureCommand("manager-pack", () => runNpmCommand(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root], managerRoot, { environment }));
    const archives = JSON.parse(packed.stdout) as { readonly name: string; readonly version: string; readonly filename: string }[];
    assert.equal(archives.length, 1);
    assert.equal(archives[0]!.name, "pnpm");
    assert.equal(archives[0]!.version, "11.20.0");
    assert.equal(archives[0]!.filename, "pnpm-11.20.0.tgz");
    await writeFile(join(ambient, "package.json"), JSON.stringify({ name: "packaging-ambient-test", version: "0.0.0" }));
    await writeFile(join(owner, "package.json"), JSON.stringify({
      name: "packaging-owner-test", private: true, type: "module", packageManager: "pnpm@11.20.0",
      devDependencies: { pnpm: "file:../pnpm-11.20.0.tgz", "packaging-ambient-test": "workspace:*" },
      scripts: {
        contamination: "pnpm --dir ../consumer --reporter=silent exec node observe.ts",
        qualification: "node qualify.ts",
      },
    }));
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", packageManager: "pnpm@11.20.0" }));
    await writeFile(join(owner, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(join(consumer, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(consumer, "observe.ts"), `
import { createRequire } from "node:module";
const specifier = "packaging-ambient-test/package.json";
let commonJs;
let esm;
try { commonJs = createRequire(import.meta.url).resolve(specifier); } catch (error) { commonJs = error.code; }
try { esm = import.meta.resolve(specifier); } catch (error) { esm = error.code; }
console.log("PACKAGING_PNPM_TEST:" + JSON.stringify({ commonJs, esm, node: process.versions.node, nodeExecutable: process.execPath,
  nodePath: process.env.NODE_PATH ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null,
  sentinel: process.env.PACKAGING_CHILD_SENTINEL }));
`);
    const helper = new URL("../scripts/pack-test-support.mjs", import.meta.url).href;
    await writeFile(join(owner, "qualify.ts"), `
import assert from "node:assert/strict";
import { createPnpmRunner } from ${JSON.stringify(helper)};
const runner = createPnpmRunner();
const before = { ...process.env };
const version = await runner(["--version"], ${JSON.stringify(consumer)});
assert.equal(version.stdout.trim(), "11.20.0");
const environment = { ...process.env, NODE_PATH: ${JSON.stringify(join(owner, "node_modules"))},
  NODE_OPTIONS: "--require=./must-not-load.cjs", PACKAGING_CHILD_SENTINEL: "preserved" };
const environmentBefore = { ...environment };
const result = await runner(["--reporter=silent", "exec", "node", "observe.ts"], ${JSON.stringify(consumer)},
  process.argv[2] === "explicit" ? { environment } : undefined);
process.stdout.write(result.stdout);
assert.deepEqual(environment, environmentBefore);
assert.deepEqual({ ...process.env }, before);
`);
    await runPackagingFixtureCommand("fixture-install", () => runCommand(node,
      [entry, "install", "--offline", "--ignore-scripts", "--no-frozen-lockfile", "--store-dir", join(root, "store")], owner, { environment }));
    const bundledManifest = "dist/node_modules/@reflink/reflink/package.json";
    assert.equal(await readFile(join(owner, "node_modules", "pnpm", bundledManifest), "utf8"),
      await readFile(join(managerRoot, bundledManifest), "utf8"));
    const control = packagingObservations((await runPackagingFixtureCommand("contamination-control", () => runCommand(node,
      [entry, "--reporter=silent", "run", "contamination"], owner, { environment }))).stdout);
    assert.equal(control.length, 1);
    assert.notEqual(control[0]!.commonJs, "MODULE_NOT_FOUND", JSON.stringify({ control,
      shim: await readFile(join(owner, "node_modules", ".bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm"), "utf8") }));
    assert.equal(await realpath(control[0]!.commonJs), await realpath(join(owner, "node_modules", "packaging-ambient-test", "package.json")));
    assert.equal(control[0]!.esm, "ERR_MODULE_NOT_FOUND");
    assert.equal(control[0]!.node, "26.11.1");
    assert.equal(await realpath(control[0]!.nodeExecutable), await realpath(node));
    assert.ok(control[0]!.nodePath, "The genuine generated pnpm shim must reproduce ambient CJS lookup.");
    for (const mode of [[], ["explicit"]]) {
      const actual = packagingObservations((await runPackagingFixtureCommand(mode.length === 0 ? "qualification-default" : "qualification-explicit", () => runCommand(node,
        [entry, "--reporter=silent", "run", "qualification", ...mode], owner, { environment }))).stdout);
      assert.equal(actual.length, 1);
      const result = actual[0]!;
      assert.equal(result.commonJs, "MODULE_NOT_FOUND");
      assert.equal(result.esm, "ERR_MODULE_NOT_FOUND");
      assert.equal(result.node, "26.11.1");
      assert.equal(await realpath(result.nodeExecutable), await realpath(node));
      assert.equal(result.nodePath, null);
      assert.equal(result.nodeOptions, null);
      if (mode.length > 0) { assert.equal(result.sentinel, "preserved"); }
    }
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
