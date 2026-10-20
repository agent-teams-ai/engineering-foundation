import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { inspectCompressedTarArchive, readRegularArchive } from "./pack-artifact-archive.mjs";
import { runCommand, runNpmCommand } from "./pack-test-support.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";
import { migrationBytes, migrationDigest, type MigrationDigest, type NativeMigrationPackageInput,
  type NativeMigrationReview } from "./public-api-native-migration.ts";
import type { PublicApiCompatibilityPolicy } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";

export const migrationRepository = "agent-teams-ai/engineering-foundation";
export const migrationSourceCommit = "4b9cc2165563361f463ca3c59277edc9af592c55";
const inputDirectory = "scripts/native-public-api-migration";
const historicalRun = 39_172_225_427;
const registry = "https://registry.npmjs.org/";
const maximumDownload = 32 * 1024 * 1024;

interface Origin {
  readonly name: string;
  readonly version: string;
  readonly publicationSourceCommit: string | null;
}
export interface NativeMigrationIntent {
  readonly kind: "foundation:public-api-native-migration:inputs:1";
  readonly review: NativeMigrationReview;
  readonly origins: readonly Origin[];
  readonly npmVersion: "11.19.0";
  readonly dependencyManifestDigest: MigrationDigest;
  readonly dependencyLockDigest: MigrationDigest;
  readonly qualifiedArchiveLogDigest: MigrationDigest;
  readonly expectedCapabilities: readonly { readonly capabilityId: string; readonly capabilityConfigSchemaVersion: number }[];
}

function fail(message: string): never { throw new Error(`Native migration inputs: ${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { fail(`${label} must be an object`); }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).toSorted().join("\0") !== expected.toSorted().join("\0")) { fail("unexpected input fields"); }
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) { fail("nonempty string required"); }
  return value;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) { fail("array required"); }
  return value;
}
function digest(value: unknown): MigrationDigest {
  const text = string(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(text)) { fail("SHA-256 digest required"); }
  return text as MigrationDigest;
}

function readReview(source: unknown): NativeMigrationReview {
  const input = record(source, "review");
  keys(input, ["kind", "from", "to", "baselineSourceCommit", "policyDigest", "toolDiffDigest", "packages"]);
  if (input["kind"] !== "foundation:public-api-native-migration:review:1" || input["from"] !== "7.58.12" ||
      input["to"] !== "typescript-native/7.0.2" || input["baselineSourceCommit"] !== migrationSourceCommit) {
    fail("only the reviewed 7.58.12 to native 7.0.2 transition is supported");
  }
  const packages = list(input["packages"]).map(value => {
    const row = record(value, "reviewed package");
    keys(row, ["packageName", "baselinePath", "baselineDigest", "archiveDigest", "archiveIntegrity", "configDigest", "releasedInputsDigest", "nativeReleasedDigest"]);
    return { packageName: string(row["packageName"]), baselinePath: string(row["baselinePath"]),
      baselineDigest: digest(row["baselineDigest"]), archiveDigest: digest(row["archiveDigest"]),
      archiveIntegrity: string(row["archiveIntegrity"]), configDigest: digest(row["configDigest"]),
      releasedInputsDigest: digest(row["releasedInputsDigest"]), nativeReleasedDigest: digest(row["nativeReleasedDigest"]) };
  });
  return { kind: input["kind"], from: input["from"], to: input["to"], baselineSourceCommit: migrationSourceCommit,
    policyDigest: digest(input["policyDigest"]), toolDiffDigest: digest(input["toolDiffDigest"]), packages };
}

export function parseNativeMigrationIntent(source: unknown): NativeMigrationIntent {
  const input = record(source, "migration input");
  keys(input, ["kind", "review", "origins", "npmVersion", "dependencyManifestDigest", "dependencyLockDigest", "qualifiedArchiveLogDigest", "expectedCapabilities"]);
  if (input["kind"] !== "foundation:public-api-native-migration:inputs:1" || input["npmVersion"] !== "11.19.0") { fail("unsupported migration input or npm version"); }
  const review = readReview(input["review"]);
  const origins = list(input["origins"]).map(value => {
    const row = record(value, "archive origin");
    keys(row, ["name", "version", "publicationSourceCommit"]);
    const name = string(row["name"]); const version = string(row["version"]);
    const commit = row["publicationSourceCommit"];
    if (!/^\d+\.\d+\.\d+$/u.test(version) ||
        (name === "@agent-teams/feature-module-standard" ? commit !== null : typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit))) {
      fail("historical publication/qualification origin differs");
    }
    return { name, version, publicationSourceCommit: commit as string | null };
  });
  if (new Set(origins.map(row => row.name)).size !== origins.length ||
      origins.map(row => row.name).toSorted().join("\0") !== review.packages.map(row => row.packageName).toSorted().join("\0")) { fail("archive origin inventory differs from review"); }
  const expectedCapabilities = list(input["expectedCapabilities"]).map(value => {
    const row = record(value, "capability"); keys(row, ["capabilityId", "capabilityConfigSchemaVersion"]);
    const version = row["capabilityConfigSchemaVersion"];
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) { fail("invalid capability version"); }
    return { capabilityId: string(row["capabilityId"]), capabilityConfigSchemaVersion: version };
  });
  return { kind: input["kind"], review, origins, npmVersion: input["npmVersion"], expectedCapabilities,
    dependencyManifestDigest: digest(input["dependencyManifestDigest"]), dependencyLockDigest: digest(input["dependencyLockDigest"]),
    qualifiedArchiveLogDigest: digest(input["qualifiedArchiveLogDigest"]) };
}

export async function readNativeMigrationIntent(root: string): Promise<NativeMigrationIntent> {
  const intent = parseNativeMigrationIntent(JSON.parse(await readFile(join(root, inputDirectory, "intent.json"), "utf8")));
  const packet = await readFile(join(root, inputDirectory, "reviewed-tool-diff.json"));
  if (migrationDigest(packet) !== intent.review.toolDiffDigest) { fail("reviewed tool difference packet changed"); }
  return intent;
}

async function gitBytes(root: string, path: string): Promise<Buffer> {
  const result = await runCommand("git", ["show", `${migrationSourceCommit}:${path}`], root);
  return Buffer.from(result.stdout);
}

async function acquireBytes(url: string): Promise<Buffer> {
  const target = new URL(url);
  if (target.origin !== "https://registry.npmjs.org" || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") { fail("archive URL is outside the fixed public registry"); }
  const response = await fetch(target, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || response.body === null) { fail(`historical archive download failed (${response.status})`); }
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumDownload) { await response.body.cancel().catch(() => {}); fail("historical archive download exceeds its budget"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readQualifiedArchiveLine(log: string, intent: NativeMigrationIntent): void {
  const marker = "Registry-install qualification PASS: ";
  const matches = log.split(/\r?\n/u).filter(line => line.includes(marker)).map(line => line.slice(line.indexOf(marker) + marker.length));
  if (matches.length !== 1 || migrationDigest(Buffer.from(matches[0]!)) !== intent.qualifiedArchiveLogDigest) { fail("protected-main archive qualification record changed or is missing"); }
  const rows = list(JSON.parse(matches[0]!));
  if (rows.length !== intent.origins.length) { fail("protected-main qualified archive set is incomplete"); }
  for (const origin of intent.origins) {
    const pin = intent.review.packages.find(row => row.packageName === origin.name)!;
    const selected = rows.map(value => record(value, "qualified archive")).filter(row => row["name"] === origin.name);
    const row = selected[0];
    if (selected.length !== 1 || row?.["version"] !== origin.version || `sha256:${String(row["sha256"])}` !== pin.archiveDigest || row["integrity"] !== pin.archiveIntegrity) { fail("historical archive is not bound to its protected-main qualification"); }
  }
}

async function verifyQualifiedOrigin(root: string, intent: NativeMigrationIntent): Promise<void> {
  const output = await runCommand("gh", ["api", `repos/${migrationRepository}/actions/runs/${historicalRun}/attempts/1`], root);
  const run = record(JSON.parse(output.stdout), "historical workflow run");
  const repository = record(run["repository"], "historical repository");
  if (run["id"] !== historicalRun || run["run_attempt"] !== 1 || run["event"] !== "push" || run["head_branch"] !== "main" ||
      run["head_sha"] !== migrationSourceCommit || run["path"] !== ".github/workflows/release.yml" || run["status"] !== "completed" ||
      run["conclusion"] !== "failure" || repository["full_name"] !== migrationRepository) { fail("historical qualified RC lacks its exact protected-main origin"); }
  const log = await runCommand("gh", ["run", "view", String(historicalRun), "--attempt", "1", "--log", "--repo", migrationRepository], root);
  readQualifiedArchiveLine(log.stdout, intent);
}

async function prepareDependencyData(root: string, temporary: string, intent: NativeMigrationIntent) {
  const destination = join(temporary, "dependency-data"); await mkdir(destination);
  for (const [name, expected] of [["package.json", intent.dependencyManifestDigest], ["package-lock.json", intent.dependencyLockDigest]] as const) {
    const bytes = await readFile(join(root, inputDirectory, name));
    if (migrationDigest(bytes) !== expected) { fail(`frozen historical ${name} changed`); }
    await writeFile(join(destination, name), bytes);
  }
  const userConfig = join(temporary, "empty-user.npmrc"); const globalConfig = join(temporary, "empty-global.npmrc");
  await writeFile(userConfig, ""); await writeFile(globalConfig, "");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^npm_config_/iu.test(name) && !/^(?:npm_token|node_auth_token)$/iu.test(name)));
  environment["NPM_CONFIG_USERCONFIG"] = userConfig; environment["NPM_CONFIG_GLOBALCONFIG"] = globalConfig;
  environment["NPM_CONFIG_CACHE"] = join(temporary, "npm-cache");
  const options = { environment, timeoutMs: 240_000 };
  const version = await runNpmCommand(["--version"], destination, options);
  if (version.stdout.trim() !== intent.npmVersion) { fail(`origin verification requires npm ${intent.npmVersion}`); }
  await runNpmCommand(["ci", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`], destination, options);
  const audit = await runNpmCommand(["audit", "signatures", "--json", "--include-attestations", `--registry=${registry}`], destination, options);
  if (migrationDigest(await readFile(join(destination, "package-lock.json"))) !== intent.dependencyLockDigest) { fail("frozen installation rewrote its dependency lock"); }
  const evidence: unknown = JSON.parse(audit.stdout);
  assertCleanAudit(evidence);
  return { root: destination, audit: evidence, options };
}

async function historicalArchive(root: string, origin: Origin, intent: NativeMigrationIntent): Promise<Buffer> {
  const pin = intent.review.packages.find(row => row.packageName === origin.name)!;
  let bytes: Buffer;
  if (origin.publicationSourceCommit === null) {
    if (origin.name !== "@agent-teams/feature-module-standard" || origin.version !== "0.1.0") { fail("unknown non-published historical origin"); }
    bytes = await readRegularArchive(join(root, inputDirectory, "feature-module-standard-0.1.0.tgz"));
  } else {
    const basename = origin.name.slice("@agent-teams/".length);
    if (!/^@agent-teams\/[a-z-]+$/u.test(origin.name)) { fail("unknown published archive namespace"); }
    bytes = await acquireBytes(`${registry}${origin.name}/-/${basename}-${origin.version}.tgz`);
  }
  if (migrationDigest(bytes) !== pin.archiveDigest || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pin.archiveIntegrity) { fail("historical archive bytes differ from review"); }
  return bytes;
}

function assertCleanAudit(evidence: unknown): Record<string, unknown> {
  const audit = record(evidence, "npm signature audit");
  if (list(audit["invalid"]).length !== 0 || list(audit["missing"]).length !== 0) { fail("npm signature audit is not clean"); }
  list(audit["verified"]);
  return audit;
}

/** This binds the fresh public npm verifier's exact seven archive subjects. It
 * makes no claim about a complete historical runtime dependency installation. */
export function assertNativeMigrationOriginAudit(evidence: unknown, intent: NativeMigrationIntent): void {
  const audit = assertCleanAudit(evidence);
  const origins = intent.origins.filter(row => row.publicationSourceCommit !== null);
  const expected = origins.map(row => `${row.name}@${row.version}`).toSorted();
  const actual = list(audit["verified"]).map(value => {
    const row = record(value, "verified archive subject");
    return `${string(row["name"])}@${string(row["version"])}`;
  }).toSorted();
  if (origins.length !== 7 || new Set(expected).size !== 7 || JSON.stringify(actual) !== JSON.stringify(expected)) { fail("npm signature audit must verify the exact seven published archive subjects"); }
  for (const origin of origins) {
    const pin = intent.review.packages.find(row => row.packageName === origin.name);
    if (pin === undefined) { fail("published archive review is missing"); }
    const provenance = verifiedProvenanceFromNpmAudit(evidence,
      { name: origin.name, version: origin.version, integrity: pin.archiveIntegrity },
      { repository: `https://github.com/${migrationRepository}`, workflow: ".github/workflows/release.yml", ref: "refs/heads/main" });
    if (provenance?.commit !== origin.publicationSourceCommit) { fail("historical publication commit differs from review"); }
  }
}

async function unpackHistoricalArchive(bytes: Uint8Array, destination: string, packageName: string): Promise<void> {
  for (const entry of inspectCompressedTarArchive(bytes, packageName).entries) {
    if (!entry.name.startsWith("package/") || !["0", "5"].includes(entry.type)) { fail("unsupported historical archive member"); }
    if (entry.type === "5") { continue; }
    const path = join(destination, entry.name.slice("package/".length));
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, entry.data, { flag: "wx" });
  }
}

async function verifyPublishedOrigins(temporary: string, intent: NativeMigrationIntent, packages: readonly NativeMigrationPackageInput[], options: Awaited<ReturnType<typeof prepareDependencyData>>["options"]) {
  const root = join(temporary, "origin-signature-subjects"); await mkdir(root);
  const origins = intent.origins.filter(row => row.publicationSourceCommit !== null);
  await writeFile(join(root, "package.json"), migrationBytes({ name: "foundation-historical-origin-signature-subjects", private: true, version: "0.0.0", type: "module",
    dependencies: Object.fromEntries(origins.map(row => [row.name, row.version])) }));
  const manifests = new Map<string, MigrationDigest>();
  for (const origin of origins) {
    const input = packages.find(row => row.packageName === origin.name);
    if (input === undefined) { fail("published archive input is missing"); }
    const destination = join(root, "node_modules", origin.name);
    await unpackHistoricalArchive(input.archiveBytes, destination, origin.name);
    const bytes = await readFile(join(destination, "package.json"));
    const manifest = record(JSON.parse(bytes.toString("utf8")), "archived manifest");
    if (manifest["name"] !== origin.name || manifest["version"] !== origin.version) { fail("archived manifest differs from its signature subject"); }
    manifests.set(origin.name, migrationDigest(bytes));
  }
  const result = await runNpmCommand(["audit", "signatures", "--json", "--include-attestations", `--registry=${registry}`], root, options);
  const audit: unknown = JSON.parse(result.stdout);
  assertNativeMigrationOriginAudit(audit, intent);
  for (const origin of origins) {
    if (migrationDigest(await readFile(join(root, "node_modules", origin.name, "package.json"))) !== manifests.get(origin.name)) { fail("npm origin verification changed an archived manifest"); }
  }
  return { root, audit };
}

/** The owned temporary namespace contains archive/configuration data only.
 * npm lifecycle scripts and historical package code are never executed. */
export async function acquireNativeMigrationInputs(root: string, temporary: string, suppliedIntent: NativeMigrationIntent, policy: PublicApiCompatibilityPolicy): Promise<{
  readonly releasedRoot: string; readonly packages: readonly NativeMigrationPackageInput[];
}> {
  const intent = structuredClone(suppliedIntent); const packagePolicies = structuredClone(policy.packages);
  const dependencies = await prepareDependencyData(root, temporary, intent);
  await verifyQualifiedOrigin(root, intent);
  const releasedRoot = join(temporary, "historical"); await mkdir(releasedRoot);
  const packages: NativeMigrationPackageInput[] = [];
  for (const p of packagePolicies) {
    const origin = intent.origins.find(row => row.name === p.packageName);
    const pin = intent.review.packages.find(row => row.packageName === p.packageName);
    if (origin === undefined || pin === undefined) { fail("historical package inventory is incomplete"); }
    const archiveBytes = await historicalArchive(root, origin, intent);
    const baselineBytes = await gitBytes(root, p.releasedBaselinePath); const configBytes = await gitBytes(root, p.tsconfigPath);
    if (migrationDigest(baselineBytes) !== pin.baselineDigest || migrationDigest(configBytes) !== pin.configDigest) { fail("original release baseline or configuration differs from review"); }
    await unpackHistoricalArchive(archiveBytes, join(releasedRoot, p.packageRoot), p.packageName);
    await writeFile(join(releasedRoot, p.tsconfigPath), configBytes, { flag: "wx" });
    packages.push({ packageName: p.packageName, baselineBytes, archiveBytes, configBytes });
  }
  const published = await verifyPublishedOrigins(temporary, intent, packages, dependencies.options);
  await cp(join(dependencies.root, "node_modules"), join(releasedRoot, "node_modules"), { recursive: true, dereference: false });
  await cp(join(published.root, "node_modules", "@agent-teams"), join(releasedRoot, "node_modules", "@agent-teams"), { recursive: true, dereference: false });
  await writeFile(join(temporary, "origin-observation.json"), migrationBytes({
    kind: "foundation:public-api-native-migration:origin-observation:1", npmVersion: intent.npmVersion,
    declarationDataAuditDigest: migrationDigest(migrationBytes(dependencies.audit)),
    archiveOriginAuditDigest: migrationDigest(migrationBytes(published.audit)), archiveOriginSubjectCount: 7,
    completeHistoricalRuntimeInstallationClaimed: false, qualificationRun: historicalRun,
    qualificationRunConclusion: "failure", publishedOrigins: intent.origins.filter(row => row.publicationSourceCommit !== null),
    recoveredQualifiedRc: "@agent-teams/feature-module-standard@0.1.0", releaseEligible: false,
  }));
  return { releasedRoot, packages };
}
