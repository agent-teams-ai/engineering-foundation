import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalDigest, runNpmCommand } from "./pack-test-support.mjs";
import { sameFileState } from "./pack-stage-stable-file.ts";
import { assertNpmSignatureEvidence } from "./release-publish-ordered-runtime.mjs";

interface PayloadFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface EffectFixtureDependencyRoot {
  readonly identity: string;
  readonly root: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly integrity: string;
  readonly files: readonly PayloadFile[];
}

export interface EffectFixtureDependencies {
  readonly pins: Readonly<Record<string, string>>;
  readonly roots: readonly EffectFixtureDependencyRoot[];
  readonly receiptPath: string;
}

const registry = "https://registry.npmjs.org/";
const fixture = new URL("../tests/fixtures/effect-diagnostics/dependencies/", import.meta.url);
const packageNames = [
  "@effect/tsgo-linux-x64",
  "@get-modular/assembly",
  "@get-modular/core",
  "@get-modular/effect",
  "effect",
] as const;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function json(bytes: Buffer): Record<string, unknown> {
  return record(JSON.parse(bytes.toString("utf8")));
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function payload(root: string): Promise<PayloadFile[]> {
  const files: PayloadFile[] = [];
  const directories = [root];
  let bytes = 0;
  let entries = 0;
  for (const directory of directories) {
    assert.ok(relative(root, directory).split(/[\\/]/u).length <= 64);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 50_000, "Effect fixture payload exceeds its entry bound");
      assert.notEqual(
        entry.name,
        "node_modules",
        "Effect fixture contains an unadmitted nested dependency tree",
      );
      const path = join(directory, entry.name);
      const state = await lstat(path);
      assert.ok(!state.isSymbolicLink(), "Effect fixture package contains a link");
      if (state.isDirectory()) {
        directories.push(path);
        continue;
      }
      assert.ok(state.isFile(), "Effect fixture payload is not a regular file");
      bytes += state.size;
      assert.ok(bytes <= 512 * 1024 * 1024, "Effect fixture payload exceeds its byte bound");
      const hash = createHash("sha256");
      let observedBytes = 0;
      for await (const chunk of createReadStream(path)) {
        observedBytes += chunk.length;
        assert.ok(observedBytes <= state.size, "Effect fixture payload grew while being read");
        hash.update(chunk);
      }
      const after = await lstat(path);
      assert.equal(observedBytes, state.size);
      assert.ok(sameFileState(state, after), "Effect fixture payload changed while being read");
      files.push({
        path: relative(root, path).replaceAll("\\", "/"),
        size: state.size,
        sha256: hash.digest("hex"),
        executable: (state.mode & 0o111) !== 0,
      });
    }
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** The seed owner adds only this exact manifest field to preserve executable modes. */
function normalizedManifest(
  actual: Record<string, unknown>,
  expected: EffectFixtureDependencyRoot,
): Record<string, unknown> {
  if (canonicalDigest(actual) === canonicalDigest(expected.manifest)) return actual;
  const publish = { ...record(actual["publishConfig"]) };
  assert.deepEqual(
    [...(publish["executableFiles"] as unknown[])].sort(),
    expected.files
      .filter((file) => file.executable)
      .map((file) => file.path)
      .sort(),
    "Registry seed executableFiles differs from the observed upstream executable inventory",
  );
  const original = expected.manifest["publishConfig"];
  if (original === undefined) {
    delete publish["executableFiles"];
    assert.deepEqual(publish, {});
    const normalized = { ...actual };
    delete normalized["publishConfig"];
    return normalized;
  }
  const originalPublish = record(original);
  if (Object.hasOwn(originalPublish, "executableFiles")) {
    publish["executableFiles"] = originalPublish["executableFiles"];
  } else {
    delete publish["executableFiles"];
  }
  return { ...actual, publishConfig: publish };
}

/** No installation: binds the installed consumer to the verified public input payloads. */
export async function assertInstalledEffectFixtureDependencies(
  consumerRoot: string,
  cohort: EffectFixtureDependencies,
): Promise<void> {
  for (const expected of cohort.roots) {
    const name = String(expected.manifest["name"]);
    const root = await realpath(join(consumerRoot, "node_modules", ...name.split("/")));
    const actual = json(await readFile(join(root, "package.json")));
    assert.equal(
      canonicalDigest(normalizedManifest(actual, expected)),
      canonicalDigest(expected.manifest),
    );
    const observed = await payload(root);
    const withoutManifest = (files: readonly PayloadFile[]) =>
      files.filter((file) => file.path !== "package.json");
    assert.deepEqual(
      withoutManifest(observed),
      withoutManifest(expected.files),
      `Installed Effect fixture payload differs from verified ${expected.identity}`,
    );
  }
}

/** Acquire only the selected Linux fixture through the existing bounded npm runner. */
export async function prepareEffectFixtureDependencies(
  temporaryRoot: string,
): Promise<EffectFixtureDependencies | undefined> {
  if (process.platform !== "linux" || process.arch !== "x64") return undefined;
  const root = join(temporaryRoot, "effect-fixture-dependencies");
  await mkdir(root);
  const manifestBytes = await readFile(new URL("package.json", fixture));
  const lockBytes = await readFile(new URL("package-lock.json", fixture));
  const pins = record(json(manifestBytes)["devDependencies"]);
  assert.deepEqual(Object.keys(pins).sort(), [...packageNames].sort());
  for (const version of Object.values(pins)) {
    assert.equal(typeof version, "string");
    assert.match(String(version), /^\d+\.\d+\.\d+$/u);
  }
  const locked = record(json(lockBytes)["packages"]);
  assert.deepEqual(
    Object.keys(locked).sort(),
    ["", ...packageNames.map((name) => `node_modules/${name}`)].sort(),
  );
  await writeFile(join(root, "package.json"), manifestBytes);
  await writeFile(join(root, "package-lock.json"), lockBytes);
  const userConfig = join(root, "empty-user.npmrc");
  const globalConfig = join(root, "empty-global.npmrc");
  await writeFile(userConfig, "");
  await writeFile(globalConfig, "");
  const cache = join(root, "npm-cache");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^npm_config_/iu.test(name) &&
        !/^(?:npm_token|node_auth_token|node_path|node_options)$/iu.test(name),
    ),
  );
  environment["NPM_CONFIG_USERCONFIG"] = userConfig;
  environment["NPM_CONFIG_GLOBALCONFIG"] = globalConfig;
  environment["NPM_CONFIG_CACHE"] = cache;
  const options = { environment, timeoutMs: 240_000 };
  const npmVersion = (await runNpmCommand(["--version"], root, options)).stdout.trim();
  await runNpmCommand(
    [
      "ci",
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
      `--registry=${registry}`,
    ],
    root,
    options,
  );
  const audit = await runNpmCommand(
    [
      "audit",
      "signatures",
      "--json",
      "--include=dev",
      "--include-attestations",
      `--registry=${registry}`,
    ],
    root,
    options,
  );
  assert.deepEqual(await readFile(join(root, "package-lock.json")), lockBytes);
  const evidence: unknown = JSON.parse(audit.stdout);
  const roots: EffectFixtureDependencyRoot[] = [];
  for (const name of packageNames) {
    const version = pins[name];
    const lockedPackage = record(locked[`node_modules/${name}`]);
    assert.equal(lockedPackage["version"], version);
    assert.equal(new URL(String(lockedPackage["resolved"])).origin, new URL(registry).origin);
    assert.match(String(lockedPackage["integrity"]), /^sha512-[A-Za-z0-9+/]+=*$/u);
    assertNpmSignatureEvidence(evidence, { name, version });
    const packageRoot = await realpath(join(root, "node_modules", ...name.split("/")));
    assert.equal(packageRoot, resolve(root, "node_modules", ...name.split("/")));
    const manifest = json(await readFile(join(packageRoot, "package.json")));
    assert.equal(manifest["name"], name);
    assert.equal(manifest["version"], version);
    roots.push({
      identity: `${name}@${String(version)}`,
      root: packageRoot,
      manifest,
      integrity: String(lockedPackage["integrity"]),
      files: await payload(packageRoot),
    });
  }
  const receiptPath = join(root, "receipt.json");
  await writeFile(join(root, "npm-signatures.json"), audit.stdout);
  const receipt = {
    event: "effect-fixture-public-inputs",
    npmVersion,
    manifestSha256: digest(manifestBytes),
    lockSha256: digest(lockBytes),
    signatureAuditSha256: digest(Buffer.from(audit.stdout)),
    signaturesAndProvenanceVerified: true,
    packages: roots.map(({ identity, integrity, files }) => ({
      identity,
      integrity,
      payload: canonicalDigest(files),
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      largestMembers: files.toSorted((left, right) => right.size - left.size).slice(0, 3),
    })),
    registryManifestNormalization:
      "canonical JSON and exact observed publishConfig.executableFiles only",
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  await rm(cache, { recursive: true, force: true });
  return { pins: pins as Readonly<Record<string, string>>, roots, receiptPath };
}
