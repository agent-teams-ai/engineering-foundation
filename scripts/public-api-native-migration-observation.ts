import { createHash } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { inspectCompressedTarArchive, portableEntryIdentity } from './pack-artifact-archive.mjs';
import { assertSchema } from '../packages/engineering-foundation/dist/schema-catalog.js';
import { readAcceptedArchitectureDecisionEvidence } from '../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js';
import { createPublicApiArtifactDependencies, createPublicApiCompatibilityDependencies } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/module.js';
import { AjvJsonSchemaReleaseInspector } from '../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js';
import { readContainedRegularFile, pathTraversesSymbolicLink } from '../packages/engineering-foundation/dist/source-inventory/node.js';
import { stagePackageSnapshot } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/staged-public-api-input.js';
import { captureNativePublicApiInputs } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-inputs.js';
import { auditToolchainIdentity } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js';
import { mapReleasedBaseline } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-baseline-mapper.js';
import { assertPackageExportCoverage } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-package-export-coverage.js';
import { analyzePublicApiCompatibility } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/analyze-public-api-compatibility.js';
import type { PublicApiRepository } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/public-api-repository.js';
import type { PublicApiCompatibilityPolicy, PublicApiItem, PublicApiPackagePolicy, PublicApiSnapshot } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js';
import type { FoundationDiagnostic } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';

export const nativeMigrationFrom = '7.58.12';
export const nativeMigrationTo = 'typescript-native/7.0.2';
export const nativeMigrationPackageNames: readonly string[] = Object.freeze(['ci-input-proof', 'docs-protocol', 'docs-protocol-agent-teams', 'docs-protocol-mcp', 'document-authoring', 'engineering-foundation', 'feature-module-standard', 'repository-mutation'].map(name => `@agent-teams/${name}`).toSorted());
export type MigrationDigest = `sha256:${string}`;
export const migrationBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const migrationDigest = (bytes: Uint8Array): MigrationDigest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function fail(message: string): never { throw new Error(`Native public API migration: ${message}`); }

export interface NativeMigrationPackageInput {
  readonly packageName: string;
  /** Original base Git bytes; never the candidate's editable replacement. */
  readonly baselineBytes: Uint8Array;
  readonly archiveBytes: Uint8Array;
  readonly configBytes: Uint8Array;
}
export interface NativeMigrationPackageObservation {
  readonly packageName: string;
  readonly baselineDigest: MigrationDigest;
  readonly archiveDigest: MigrationDigest;
  readonly archiveIntegrity: string;
  readonly configDigest: MigrationDigest;
  readonly releasedInputsDigest: MigrationDigest;
  readonly nativeReleasedDigest: MigrationDigest;
  readonly baseline: PublicApiSnapshot;
  readonly nativeReleased: PublicApiSnapshot;
  readonly nativeCandidate: PublicApiSnapshot;
}
export interface NativeMigrationToolDifference {
  readonly kind: 'foundation:public-api-native-migration:tool-diff:1';
  readonly packages: readonly {
    readonly packageName: string; readonly from: string; readonly to: string;
    readonly entrypoints: readonly {
      readonly exportPath: string; readonly oldCount: number; readonly nativeCount: number;
      readonly removed: readonly string[]; readonly added: readonly string[];
      readonly changed: readonly { readonly id: string; readonly before: PublicApiItem; readonly after: PublicApiItem; readonly structural: readonly string[] }[];
    }[];
  }[];
}
export interface NativeMigrationObservation {
  readonly kind: 'foundation:public-api-native-migration:observation:1';
  readonly policyDigest: MigrationDigest;
  readonly toolchainIdentity: string;
  readonly packages: readonly NativeMigrationPackageObservation[];
  readonly toolDiff: NativeMigrationToolDifference;
  readonly toolDiffDigest: MigrationDigest;
  readonly typedDiagnostics: readonly FoundationDiagnostic[];
  readonly artifactDiagnostics: readonly FoundationDiagnostic[];
}

export function nativeMigrationToolDifference(packages: readonly Pick<NativeMigrationPackageObservation, 'packageName' | 'baseline' | 'nativeReleased'>[]): NativeMigrationToolDifference {
  return { kind: 'foundation:public-api-native-migration:tool-diff:1', packages: packages.toSorted((a, b) => order(a.packageName, b.packageName)).map(({ packageName, baseline, nativeReleased }) => {
    if (baseline.extractorVersion !== nativeMigrationFrom || nativeReleased.extractorVersion !== nativeMigrationTo || baseline.packageName !== packageName || nativeReleased.packageName !== packageName || baseline.packageVersion !== nativeReleased.packageVersion) {fail('historical observation identity mismatch');}
    if (JSON.stringify(baseline.entrypoints.map(x => x.exportPath)) !== JSON.stringify(nativeReleased.entrypoints.map(x => x.exportPath))) {fail('historical export coverage changed');}
    return { packageName, from: baseline.extractorVersion, to: nativeReleased.extractorVersion, entrypoints: nativeReleased.entrypoints.map((entry, index) => {
      const previous = baseline.entrypoints[index]!;
      const before = new Map(previous.items.map(item => [item.canonicalReference, item]));
      const after = new Map(entry.items.map(item => [item.canonicalReference, item]));
      const removed = [...before.keys()].filter(id => !after.has(id));
      const added = [...after.keys()].filter(id => !before.has(id));
      const changed = [...before].flatMap(([id, value]) => {
        const next = after.get(id);
        if (next === undefined || JSON.stringify(value) === JSON.stringify(next)) {return [];}
        const structural = [...new Set([...Object.keys(value), ...Object.keys(next)])].filter(key => key !== 'signature' && JSON.stringify(value[key as keyof PublicApiItem]) !== JSON.stringify(next[key as keyof PublicApiItem]));
        return [{ id, before: value, after: next, structural }];
      });
      if (removed.length > 0 || added.length > 0 || changed.some(item => item.structural.length > 0)) {fail(`historical item identity/kind/parent loss or addition in ${packageName} ${entry.exportPath}`);}
      return { exportPath: entry.exportPath, oldCount: before.size, nativeCount: after.size, removed, added, changed };
    }) };
  }) };
}

function addReleasedArchiveFiles(expected: Map<string, Uint8Array>, policy: PublicApiPackagePolicy, input: NativeMigrationPackageInput): number {
  const identities = new Map<string, string>();
  let bytes = 0;
  for (const entry of inspectCompressedTarArchive(Buffer.from(input.archiveBytes), policy.packageName).entries) {
    if (entry.type !== '0' && entry.type !== '5') { fail('historical archive has a special member'); }
    if (!entry.name.startsWith('package/')) { fail('historical archive member is outside package/'); }
    const identity = portableEntryIdentity(entry.name);
    if (identities.has(identity)) { fail('historical archive has normalized-colliding members'); }
    identities.set(identity, entry.type);
    if (entry.type !== '0') { continue; }
    const path = `${policy.packageRoot}/${entry.name.slice('package/'.length)}`;
    if (expected.has(path)) { fail('duplicate historical archive member'); }
    expected.set(path, entry.data); bytes += entry.data.byteLength;
  }
  for (const identity of identities.keys()) {
    const parts = identity.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (identities.get(parts.slice(0, depth).join('/')) === '0') { fail('historical archive file is an ancestor'); }
    }
  }
  return bytes;
}

/** The host authenticates archive origins and excludes writers for the entire
 * released namespace and installed declaration closure. These checks bind bytes;
 * they do not authenticate a producer or sandbox a hostile same-user writer. */
async function assertReleasedNamespace(root: string, policy: PublicApiCompatibilityPolicy, inputs: readonly NativeMigrationPackageInput[]): Promise<void> {
  const expected = new Map<string, Uint8Array>();
  let bytes = 0; let compressedBytes = 0;
  for (const p of policy.packages) {
    const input = inputs.find(row => row.packageName === p.packageName)!;
    compressedBytes += input.archiveBytes.byteLength;
    if (compressedBytes > 32 * 1024 * 1024 || input.baselineBytes.byteLength > 32 * 1024 * 1024 || input.configBytes.byteLength > 32 * 1024 * 1024) {fail('historical packet byte budget exceeded');}
    bytes += addReleasedArchiveFiles(expected, p, input);
    if (expected.has(p.tsconfigPath)) {fail('historical archive unexpectedly includes build configuration');}
    expected.set(p.tsconfigPath, input.configBytes); bytes += input.configBytes.byteLength;
    const manifestBytes = expected.get(p.manifestPath);
    if (manifestBytes === undefined) {fail('historical archive has no manifest');}
    const manifest: unknown = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
    const baseline = mapReleasedBaseline(JSON.parse(Buffer.from(input.baselineBytes).toString('utf8')), p);
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) || !('version' in manifest) || manifest.name !== p.packageName || manifest.version !== baseline.packageVersion) {fail('historical archive package/version differs from original baseline');}
    assertPackageExportCoverage({ manifest, policy: p });
  }
  if (bytes > 128 * 1024 * 1024 || expected.size > 20_000) {fail('historical input budget exceeded');}
  const found = new Set<string>();
  let count = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 50_000) {fail('historical directory budget exceeded');}
      if (entry.name === 'node_modules') {continue;}
      const file = join(directory, entry.name); const path = relative(root, file).replaceAll('\\', '/');
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || entry.isSymbolicLink()) {fail(`historical namespace contains a special member: ${path}`);}
      const original = expected.get(path);
      if (original === undefined || !Buffer.from(original).equals(await readContainedRegularFile({ root, candidate: file, maxBytes: original.byteLength }))) {fail(`historical namespace differs from archive/config data: ${path}`);}
      found.add(path);
    }
  }
  if (!(await lstat(root)).isDirectory()) {fail('historical root is not a directory');}
  await visit(root);
  if (found.size !== expected.size) {fail('historical archive/config member is missing');}
}

async function releasedInputDigest(root: string, policy: PublicApiPackagePolicy, signal?: AbortSignal): Promise<MigrationDigest> {
  const staged = await stagePackageSnapshot({ root, policy }, { files: { read: readContainedRegularFile }, paths: { traversesSymbolicLink: pathTraversesSymbolicLink } });
  try {
    const files = await captureNativePublicApiInputs({ stagingRoot: staged.stagingRoot, packageRoot: staged.packageRoot, ...(signal === undefined ? {} : { signal }) });
    const inventory = [...files].map(([path, text]) => ({ path: relative(staged.stagingRoot, path).replaceAll('\\', '/'), digest: migrationDigest(Buffer.from(text)) })).toSorted((a, b) => order(a.path, b.path));
    if (inventory.some(row => row.path.startsWith('../'))) {fail('native input capture escaped its virtual namespace');}
    return migrationDigest(migrationBytes(inventory));
  } finally { await rm(staged.stagingRoot, { recursive: true, force: true }); }
}

export async function observeNativeMigration(options: {
  readonly consumerRoot: string; readonly releasedRoot: string;
  readonly policy: PublicApiCompatibilityPolicy; readonly packages: readonly NativeMigrationPackageInput[];
  readonly signal?: AbortSignal;
}): Promise<NativeMigrationObservation> {
  const input = { consumerRoot: options.consumerRoot, releasedRoot: options.releasedRoot, policy: structuredClone(options.policy), packages: structuredClone(options.packages), ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const names = input.policy.packages.map(p => p.packageName).toSorted();
  if (JSON.stringify(names) !== JSON.stringify(nativeMigrationPackageNames) || JSON.stringify(input.packages.map(p => p.packageName).toSorted()) !== JSON.stringify(names)) {fail('exact governed eight-package inventory is required');}
  if (resolve(input.consumerRoot) === resolve(input.releasedRoot)) {fail('candidate cannot be the historical observation root');}
  await assertReleasedNamespace(input.releasedRoot, input.policy, input.packages);
  const dependencies = createPublicApiCompatibilityDependencies(i => readAcceptedArchitectureDecisionEvidence(i, assertSchema), assertSchema);
  const packages: NativeMigrationPackageObservation[] = [];
  for (const p of input.policy.packages) {
    const source = input.packages.find(row => row.packageName === p.packageName)!;
    const parsed: unknown = JSON.parse(Buffer.from(source.baselineBytes).toString('utf8'));
    await assertSchema('package-public-api-baseline/v1', parsed, 'public-api-native-migration');
    const baseline = mapReleasedBaseline(parsed, p);
    const closure = await releasedInputDigest(input.releasedRoot, p, input.signal);
    const nativeReleased = await dependencies.extractor.extract(input.releasedRoot, p, baseline.packageVersion, input.signal);
    const evidence = await dependencies.repository.readReleaseEvidence(input.consumerRoot, input.policy.changesetDirectory, p, input.signal);
    const nativeCandidate = await dependencies.extractor.extract(input.consumerRoot, p, evidence.packageVersion, input.signal);
    packages.push({ packageName: p.packageName, baselineDigest: migrationDigest(source.baselineBytes), archiveDigest: migrationDigest(source.archiveBytes), archiveIntegrity: `sha512-${createHash('sha512').update(source.archiveBytes).digest('base64')}`, configDigest: migrationDigest(source.configBytes), releasedInputsDigest: closure, nativeReleasedDigest: migrationDigest(migrationBytes(nativeReleased)), baseline, nativeReleased, nativeCandidate });
  }
  await assertReleasedNamespace(input.releasedRoot, input.policy, input.packages);
  const repository: PublicApiRepository = {
    readReleasedBaseline: async (_root, p) => packages.find(row => row.packageName === p.packageName)!.nativeReleased,
    readReleaseEvidence: dependencies.repository.readReleaseEvidence.bind(dependencies.repository),
    describeReleasedBaselineWrite: dependencies.repository.describeReleasedBaselineWrite.bind(dependencies.repository),
    writeReleasedBaseline: async () => fail('observation cannot write a baseline')
  };
  const extractor = { extract: async (_root: string, p: PublicApiPackagePolicy) => packages.find(row => row.packageName === p.packageName)!.nativeCandidate };
  const typedDiagnostics = await analyzePublicApiCompatibility(input, { ...dependencies, repository, extractor });
  const artifacts = await createPublicApiArtifactDependencies(input.consumerRoot, input.policy.packages, dependencies, new AjvJsonSchemaReleaseInspector({ read: readContainedRegularFile }), input.signal);
  const artifactDiagnostics = await analyzePublicApiCompatibility(input, artifacts);
  const toolDiff = nativeMigrationToolDifference(packages);
  return { kind: 'foundation:public-api-native-migration:observation:1', policyDigest: migrationDigest(migrationBytes(input.policy)), toolchainIdentity: auditToolchainIdentity(), packages, toolDiff, toolDiffDigest: migrationDigest(migrationBytes(toolDiff)), typedDiagnostics, artifactDiagnostics };
}
