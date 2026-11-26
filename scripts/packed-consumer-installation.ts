import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./pack-test-support.mjs";
import {
  assertInstalledEffectFixtureDependencies,
  type EffectFixtureDependencies,
} from "./effect-fixture-dependencies.ts";

interface PackedConsumerInstallation {
  readonly consumerRoot: string;
  readonly packageManager: string;
  readonly archiveFileSpecifier: string;
  readonly stackToolchainArchiveFileSpecifier: string;
  readonly documentAuthoringArchiveFileSpecifier: string;
  readonly mutationArchiveFileSpecifier: string;
  readonly toolingVersions: {
    readonly oxlint: string;
    readonly oxlintTsgolint: string;
    readonly typescript: string;
  };
  readonly effectDependencies?: EffectFixtureDependencies;
  readonly runPnpm: (args: readonly string[], cwd: string) => Promise<{ readonly stdout: string }>;
}

interface InstalledManifest extends Record<string, unknown> {
  readonly version: string;
}

const foundationPackage = "@agent-teams/engineering-foundation";

function consumerManifest(
  input: PackedConsumerInstallation,
  foundationVersion: string,
  stackVersion: string,
) {
  return {
    name: "foundation-pack-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: input.packageManager,
    scripts: {
      "spec:typegen": "consumer-owned-type-generation",
      "spec:property": "consumer-owned-property-tests",
      "spec:mutation": "consumer-owned-mutation-tests",
    },
    devDependencies: {
      eslint: "catalog:",
      [foundationPackage]: foundationVersion,
      "jsonc-parser": "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      typescript: "catalog:",
      ...Object.fromEntries(
        Object.keys(input.effectDependencies?.pins ?? {}).map((name) => [name, "catalog:"]),
      ),
      "stack-toolchain": stackVersion,
    },
  };
}

async function writeInstallManifests(input: PackedConsumerInstallation): Promise<void> {
  await writeJson(
    join(input.consumerRoot, "package.json"),
    consumerManifest(input, input.archiveFileSpecifier, input.stackToolchainArchiveFileSpecifier),
  );
  await writeFile(
    join(input.consumerRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\noverrides:\n  "@agent-teams/engineering-foundation": ${JSON.stringify(input.archiveFileSpecifier)}\n  "@agent-teams/document-authoring": ${JSON.stringify(input.documentAuthoringArchiveFileSpecifier)}\n  "@agent-teams/repository-mutation": ${JSON.stringify(input.mutationArchiveFileSpecifier)}\n  "stack-toolchain": ${JSON.stringify(input.stackToolchainArchiveFileSpecifier)}\ncatalogMode: strict\ncatalog:\n  eslint: 10.3.0\n  jsonc-parser: 3.3.1\n  oxlint: ${input.toolingVersions.oxlint}\n  oxlint-tsgolint: ${input.toolingVersions.oxlintTsgolint}\n  typescript: ${input.toolingVersions.typescript}\n${Object.entries(
      input.effectDependencies?.pins ?? {},
    )
      .map(([name, version]) => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}\n`)
      .join("")}`,
    "utf8",
  );
}

async function installedManifest(root: string, name: string): Promise<InstalledManifest> {
  const value: unknown = await readJson(join(root, "node_modules", name, "package.json"));
  assert.ok(value !== null && typeof value === "object" && "version" in value);
  assert.equal(typeof value.version, "string");
  return value as InstalledManifest;
}

export async function installPackedPackage(
  input: PackedConsumerInstallation,
): Promise<InstalledManifest> {
  await writeInstallManifests(input);
  await input.runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile"], input.consumerRoot);
  if (input.effectDependencies !== undefined) {
    const lock = await readFile(join(input.consumerRoot, "pnpm-lock.yaml"));
    await input.runPnpm(["install", "--ignore-scripts", "--frozen-lockfile"], input.consumerRoot);
    assert.deepEqual(await readFile(join(input.consumerRoot, "pnpm-lock.yaml")), lock);
    await assertInstalledEffectFixtureDependencies(input.consumerRoot, input.effectDependencies);
  }
  const { stdout: versionOutput } = await input.runPnpm(
    ["--reporter=silent", "exec", "agent-teams-foundation", "--version"],
    input.consumerRoot,
  );
  const packedManifest = await installedManifest(input.consumerRoot, foundationPackage);
  if (versionOutput.trim() !== packedManifest.version) {
    throw new Error("Packed CLI version differs from packed package version.");
  }
  const stackManifest = await installedManifest(input.consumerRoot, "stack-toolchain");
  await writeJson(
    join(input.consumerRoot, "package.json"),
    consumerManifest(input, packedManifest.version, stackManifest.version),
  );
  return packedManifest;
}
