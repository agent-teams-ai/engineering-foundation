import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyQualificationNode } from "../tools/executable-policy.mts";
import { runCommand } from "./pack-test-support.mjs";

const registry = "https://registry.npmjs.org/";
const version = "10.9.11";
const archive = "https://registry.npmjs.org/npm/-/npm-10.9.11.tgz";
const integrity =
  "sha512-PakPh1DVnNuaxWehZ9dDQcvBAmpJq7knHiDWKGSxT58V11cDVCZzLh2N+pjMUaT2aKbjzfpbgtc8MXMegN7IjA==";
const inputDirectory = new URL(
  "../tests/fixtures/effect-diagnostics/registry-frozen-client/",
  import.meta.url,
);
const verifierVersion = "21.5.1";
const mismatchVersion = "0.0.0-effect-fixture-mismatch";
const commandTimeoutMs = 120_000;

interface Signature {
  readonly keyid: string;
  readonly sig: string;
}

interface FrozenConsumer {
  readonly consumerRoot: string;
  readonly registryUrl: string;
  readonly cacheRoot: string;
  readonly userConfigPath: string;
  readonly timeoutMs: number;
}

export interface EffectRegistryFrozenClient {
  readonly reinstall: (consumer: FrozenConsumer) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function json(bytes: Buffer): Record<string, unknown> {
  return record(JSON.parse(bytes.toString("utf8")));
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Admit the release and ordinary qualification bootstraps with their exact verifier. */
export function assertFrozenClientBootstrap(value: unknown): "11.19.0" | "11.20.0" {
  const observed = record(value);
  const bootstrapVersion = observed["bootstrapVersion"];
  assert.ok(bootstrapVersion === "11.19.0" || bootstrapVersion === "11.20.0");
  assert.equal(observed["verifierVersion"], verifierVersion);
  return bootstrapVersion;
}

function signatures(value: unknown): readonly Signature[] {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 16);
  return value.map((item: unknown) => {
    const entry = record(item);
    assert.ok(typeof entry["keyid"] === "string" && entry["keyid"].length <= 200);
    assert.ok(typeof entry["sig"] === "string" && entry["sig"].length <= 1024);
    assert.match(entry["keyid"], /^SHA256:[A-Za-z0-9+/]+={0,2}$/u);
    assert.match(entry["sig"], /^[A-Za-z0-9+/]+={0,2}$/u);
    return { keyid: entry["keyid"], sig: entry["sig"] };
  });
}

/** Validate the witness only after the fixed official verification call succeeds. */
export function assertFrozenClientSignature(value: unknown): readonly string[] {
  const manifest = record(value);
  const distribution = record(manifest["dist"]);
  assert.equal(manifest["name"], "npm");
  assert.equal(manifest["version"], version);
  assert.equal(manifest["_id"], "npm@" + version);
  assert.equal(manifest["_resolved"], archive);
  assert.equal(distribution["tarball"], archive);
  assert.equal(manifest["_integrity"], integrity);
  assert.equal(distribution["integrity"], integrity);
  const signed = signatures(distribution["signatures"]);
  assert.deepEqual(signatures(manifest["_signatures"]), signed);
  return signed.map((item) => item.keyid);
}

export function assertFrozenClientInput(manifestValue: unknown, lockValue: unknown): void {
  const manifest = record(manifestValue);
  const lock = record(lockValue);
  assert.deepEqual(manifest, {
    name: "foundation-effect-registry-frozen-client",
    version: "0.0.0",
    private: true,
    type: "module",
    devDependencies: { npm: version },
  });
  assert.equal(lock["lockfileVersion"], 3);
  const packages = record(lock["packages"]);
  assert.equal(Object.keys(packages).length, 197);
  assert.deepEqual(record(record(packages[""])["devDependencies"]), { npm: version });
  const candidate = record(packages["node_modules/npm"]);
  assert.equal(candidate["version"], version);
  assert.equal(candidate["resolved"], archive);
  assert.equal(candidate["integrity"], integrity);
  for (const [path, value] of Object.entries(packages)) {
    if (path === "" || path === "node_modules/npm") {
      continue;
    }
    assert.ok(path.startsWith("node_modules/npm/node_modules/"));
    assert.ok(!path.split("/").includes("..") && !path.includes("\\"));
    const bundled = record(value);
    assert.equal(bundled["inBundle"], true);
    assert.equal(typeof bundled["version"], "string");
  }
}

function contained(root: string, filename: string): void {
  const suffix = relative(root, filename);
  assert.ok(suffix !== "" && suffix !== ".." && !suffix.startsWith("../"));
  assert.ok(!isAbsolute(suffix));
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^npm_config_/iu.test(name) &&
        !/^(?:npm_token|node_auth_token|node_path|node_options|node_tls_reject_unauthorized)$/iu.test(
          name,
        ),
    ),
  );
}

async function privateEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const userConfig = join(root, "empty-user.npmrc");
  const globalConfig = join(root, "empty-global.npmrc");
  await writeFile(userConfig, "");
  await writeFile(globalConfig, "");
  return {
    ...cleanEnvironment(),
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: join(root, "cache"),
  };
}

interface ManifestVerifier {
  manifest(spec: string, options: Readonly<Record<string, unknown>>): Promise<unknown>;
}

function isManifestVerifier(value: unknown): value is ManifestVerifier {
  return (
    value !== null && typeof value === "object" && typeof record(value)["manifest"] === "function"
  );
}

async function trustedVerifier(root: string) {
  const found = await runCommand("which", ["npm"], root, { timeoutMs: 10_000 });
  const requested = found.stdout.trim();
  assert.ok(isAbsolute(requested) && !/[\r\n]/u.test(requested));
  assert.equal(found.stderr, "");
  const cli = await realpath(requested);
  const npmRoot = dirname(dirname(cli));
  assert.equal(cli, join(npmRoot, "bin/npm-cli.js"));
  const npmManifest = json(await readFile(join(npmRoot, "package.json")));
  assert.equal(npmManifest["name"], "npm");
  const fromNpm = createRequire(cli);
  const verifierManifest = await realpath(fromNpm.resolve("pacote/package.json"));
  const entrypoint = await realpath(fromNpm.resolve("pacote"));
  contained(npmRoot, verifierManifest);
  contained(dirname(verifierManifest), entrypoint);
  const metadata = json(await readFile(verifierManifest));
  assert.equal(metadata["name"], "pacote");
  const bootstrapVersion = assertFrozenClientBootstrap({
    bootstrapVersion: npmManifest["version"],
    verifierVersion: metadata["version"],
  });
  const api: unknown = fromNpm(entrypoint);
  assert.ok(isManifestVerifier(api));
  return { api, cli, bootstrapVersion };
}

async function registryKeys(signal: AbortSignal) {
  const response = await fetch(registry + "-/npm/v1/keys", { redirect: "error", signal });
  assert.ok(response.ok && response.body !== null);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= 64 * 1024, "Registry keys exceed the response bound");
    chunks.push(chunk);
  }
  const keys = json(Buffer.concat(chunks))["keys"];
  assert.ok(Array.isArray(keys) && keys.length > 0 && keys.length <= 16);
  const seen = new Set<string>();
  return keys.map((value: unknown) => {
    const key = record(value);
    assert.ok(typeof key["keyid"] === "string" && key["keyid"].length <= 200);
    assert.match(key["keyid"], /^SHA256:[A-Za-z0-9+/]+={0,2}$/u);
    assert.ok(typeof key["key"] === "string" && key["key"].length <= 4096);
    assert.match(key["key"], /^[A-Za-z0-9+/]+={0,2}$/u);
    assert.ok(!seen.has(key["keyid"]));
    seen.add(key["keyid"]);
    const expires = key["expires"];
    assert.ok(
      expires === null || (typeof expires === "string" && Number.isFinite(Date.parse(expires))),
    );
    return {
      keyid: key["keyid"],
      expires,
      pemkey: "-----BEGIN PUBLIC KEY-----\n" + key["key"] + "\n-----END PUBLIC KEY-----",
    };
  });
}

async function verifyOfficialSignature(root: string) {
  await verifyQualificationNode(process.execPath);
  const { api, cli, bootstrapVersion } = await trustedVerifier(root);
  const signal = AbortSignal.timeout(60_000);
  const keys = await registryKeys(signal);
  const manifest = await api.manifest("npm@" + version, {
    registry,
    cache: join(root, "cache"),
    verifySignatures: true,
    verifyAttestations: false,
    "//registry.npmjs.org/:_keys": keys,
    strictSSL: true,
    offline: false,
    preferOnline: true,
    signal,
    timeout: 60_000,
    retry: { retries: 0 },
  });
  return {
    bootstrapCli: cli,
    bootstrapVersion,
    verifierVersion,
    signatureKeyIds: assertFrozenClientSignature(manifest),
    integrity,
    verification: "official pacote.manifest with verifySignatures:true",
    slsaBuildProvenance: "not-demonstrated",
  };
}

/** Require the intended required-dependency refusal, not an arbitrary failure. */
export function assertFrozenMismatchRejection(error: unknown): void {
  const failure = record(error);
  assert.equal(failure["code"], 1);
  assert.equal(failure["terminationConfirmed"], true);
  assert.equal(failure["timedOut"], false);
  assert.equal(failure["signal"], null);
  const stderr = String(failure["stderr"]);
  assert.match(stderr, /^npm error code EUSAGE$/mu);
  assert.ok(
    stderr.includes(
      "Invalid: lock file's effect@" + mismatchVersion + " does not satisfy effect@4.1.4",
    ),
  );
}

async function reinstallFrozen(
  node: string,
  cli: string,
  consumer: FrozenConsumer,
  bootstrapVersion: ReturnType<typeof assertFrozenClientBootstrap>,
) {
  const filename = join(consumer.consumerRoot, "package-lock.json");
  const original = await readFile(filename);
  const locked = json(original);
  const packages = record(locked["packages"]);
  const effect = record(packages["node_modules/effect"]);
  assert.equal(effect["version"], "4.1.4");
  effect["version"] = mismatchVersion;
  const wrong = Buffer.from(JSON.stringify(locked, null, 2) + "\n");
  const args = [
    cli,
    "ci",
    "--ignore-scripts",
    "--include=dev",
    "--no-audit",
    "--no-fund",
    "--registry",
    consumer.registryUrl,
    "--cache",
    consumer.cacheRoot,
    "--userconfig",
    consumer.userConfigPath,
    "--loglevel=error",
  ];
  const options = { timeoutMs: consumer.timeoutMs, environment: cleanEnvironment() };
  try {
    await writeFile(filename, wrong);
    let rejection: unknown;
    try {
      await runCommand(node, args, consumer.consumerRoot, options);
    } catch (error) {
      rejection = error;
    }
    assertFrozenMismatchRejection(rejection);
    assert.deepEqual(await readFile(filename), wrong);
  } finally {
    await writeFile(filename, original);
  }
  await runCommand(node, args, consumer.consumerRoot, options);
  assert.deepEqual(await readFile(filename), original);
  process.stdout.write(
    JSON.stringify({
      event: "effect-registry-frozen-reinstall",
      initialInstaller: "npm@" + bootstrapVersion,
      frozenInstaller: "npm@" + version,
      requiredMismatchRejected: true,
      lockSha256: digest(original),
      lockUnchanged: true,
    }) + "\n",
  );
}

/** Private Linux fixture tool; ordinary npm installation and product pins stay with their owner. */
export async function prepareEffectRegistryFrozenClient(
  temporaryRoot: string,
): Promise<EffectRegistryFrozenClient> {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const node = await verifyQualificationNode(process.execPath);
  const root = join(temporaryRoot, "effect-registry-frozen-client");
  await mkdir(root);
  const manifestBytes = await readFile(new URL("package.json", inputDirectory));
  const lockBytes = await readFile(new URL("package-lock.json", inputDirectory));
  assertFrozenClientInput(json(manifestBytes), json(lockBytes));
  await writeFile(join(root, "package.json"), manifestBytes);
  await writeFile(join(root, "package-lock.json"), lockBytes);
  const environment = await privateEnvironment(root);
  const options = { environment, timeoutMs: commandTimeoutMs };
  const verified = await runCommand(
    node,
    ["--max-old-space-size=512", fileURLToPath(import.meta.url), "--verify-signature", root],
    root,
    options,
  );
  assert.equal(verified.stderr, "");
  const proof = record(JSON.parse(verified.stdout));
  const bootstrapVersion = assertFrozenClientBootstrap(proof);
  assert.equal(proof["integrity"], integrity);
  const bootstrapCli = proof["bootstrapCli"];
  assert.ok(typeof bootstrapCli === "string" && isAbsolute(bootstrapCli));
  await runCommand(
    node,
    [
      bootstrapCli,
      "ci",
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
      "--registry=" + registry,
    ],
    root,
    options,
  );
  assert.deepEqual(await readFile(join(root, "package-lock.json")), lockBytes);
  const packageRoot = await realpath(join(root, "node_modules/npm"));
  assert.equal(packageRoot, join(root, "node_modules/npm"));
  const manifest = json(await readFile(join(packageRoot, "package.json")));
  assert.equal(manifest["name"], "npm");
  assert.equal(manifest["version"], version);
  assert.equal(record(manifest["bin"])["npm"], "bin/npm-cli.js");
  const cli = await realpath(join(packageRoot, "bin/npm-cli.js"));
  contained(packageRoot, cli);
  const observed = await runCommand(node, [cli, "--version"], root, options);
  assert.equal(observed.stdout.trim(), version);
  assert.equal(observed.stderr, "");
  const receipt = {
    event: "effect-registry-frozen-client",
    ...proof,
    manifestSha256: digest(manifestBytes),
    lockSha256: digest(lockBytes),
    installedClientVersion: observed.stdout.trim(),
  };
  await writeFile(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt) + "\n");
  await rm(join(root, "cache"), { recursive: true, force: true });
  return { reinstall: (consumer) => reinstallFrozen(node, cli, consumer, bootstrapVersion) };
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(process.argv[2], "--verify-signature");
  assert.equal(process.argv.length, 4);
  const root = process.argv[3];
  assert.ok(root !== undefined && isAbsolute(root));
  process.stdout.write(JSON.stringify(await verifyOfficialSignature(root)));
}
