import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeJson, writePackedCiInputProofHarness } from './ci-input-proof-packed-harness.mts';

type PackedArtifact = Readonly<{
  archiveFileSpecifier: string;
  archivePath: string;
  packageName: string;
  packageVersion: string;
}>;
type RunPnpm = (
  args: string[],
  cwd: string,
  options?: Readonly<Record<string, unknown>>,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;
type InstalledToolchainEvidence = Readonly<{
  installMs: number;
  installedTypesNode: string;
  installedTypescript: string;
  typescriptPlatforms: readonly string[];
}>;
type PackedCiInputProofEvidence = Readonly<{
  status: 'passed';
  packageName: string;
  packageVersion: string;
  cases: readonly string[];
  typedPublicRoot: boolean;
  deepImportRejected: boolean;
  facts: Readonly<{
    archiveFile: string;
    archiveSha512: string;
    node: string;
    pnpm: string;
    typescriptCompiler: string;
    installedTypescript: string;
    installedTypesNode: string;
    typescriptPlatforms: readonly string[];
  }>;
  processTimingsMs: Readonly<Record<string, Readonly<{
    comparison: number;
    optimizer: number;
    full: number;
    total: number;
    clock: string;
  }>>>;
  timingsMs: Readonly<{ install: number; typecheck: number; conformance: number; total: number }>;
}>;

async function packInstalledTypeScript(
  temporaryRoot: string,
  repositoryRoot: string,
  runPnpm: RunPnpm,
): Promise<Readonly<{
  platformArchiveSpecifier: string;
  platformPackageName: string;
  typescriptArchiveSpecifier: string;
}>> {
  const toolchainRoot = join(temporaryRoot, 'toolchain-archives');
  await mkdir(toolchainRoot, { recursive: true });
  const requireFromRepository = createRequire(join(repositoryRoot, 'package.json'));
  const packageRoot = dirname(requireFromRepository.resolve('typescript/package.json'));
  const typescriptManifestPath = join(packageRoot, 'package.json');
  const typescriptManifest = JSON.parse(await readFile(typescriptManifestPath, 'utf8')) as Readonly<{
    name?: unknown;
    version?: unknown;
    optionalDependencies?: Record<string, unknown>;
  }>;
  const platformPackageName = `@typescript/typescript-${process.platform}-${process.arch}`;
  if (typescriptManifest.name !== 'typescript' || typescriptManifest.version !== '7.0.2'
      || typescriptManifest.optionalDependencies?.[platformPackageName] !== '7.0.2') {
    throw new Error('Packed CI Input Proof could not identify the exact TypeScript 7.0.2 platform dependency.');
  }
  const requireTypeScript = createRequire(typescriptManifestPath);
  const platformRoot = dirname(requireTypeScript.resolve(`${platformPackageName}/package.json`));
  const packedTypescript = await runPnpm([
    '--dir', packageRoot, 'pack', '--pack-destination', toolchainRoot, '--json',
  ], repositoryRoot);
  const packedPlatform = await runPnpm([
    '--dir', platformRoot, 'pack', '--pack-destination', toolchainRoot, '--json',
  ], repositoryRoot);
  const typescriptReport = JSON.parse(packedTypescript.stdout) as Readonly<{
    name?: unknown;
    version?: unknown;
    filename?: unknown;
  }>;
  const platformReport = JSON.parse(packedPlatform.stdout) as Readonly<{
    name?: unknown;
    version?: unknown;
    filename?: unknown;
  }>;
  if (typescriptReport.name !== 'typescript' || typescriptReport.version !== '7.0.2'
      || typeof typescriptReport.filename !== 'string'
      || platformReport.name !== platformPackageName || platformReport.version !== '7.0.2'
      || typeof platformReport.filename !== 'string') {
    throw new Error('Packed CI Input Proof could not materialize the exact TypeScript 7.0.2 toolchain.');
  }
  return Object.freeze({
    platformArchiveSpecifier: `file:${resolve(platformReport.filename)}`,
    platformPackageName,
    typescriptArchiveSpecifier: `file:${resolve(typescriptReport.filename)}`,
  });
}

async function copyInstalledTypeSupport(
  repositoryRoot: string,
  consumerRoot: string,
  platformPackageName: string,
): Promise<Readonly<{ typescriptPlatforms: readonly string[] }>> {
  const requireFromRepository = createRequire(join(repositoryRoot, 'package.json'));
  const typesNodeManifestPath = requireFromRepository.resolve('@types/node/package.json');
  const typesNodeRoot = dirname(typesNodeManifestPath);
  const undiciTypesManifestPath = createRequire(typesNodeManifestPath)
    .resolve('undici-types/package.json');
  await mkdir(join(consumerRoot, 'node_modules', '@types'), { recursive: true });
  await cp(typesNodeRoot, join(consumerRoot, 'node_modules', '@types', 'node'), { recursive: true });
  await cp(
    dirname(undiciTypesManifestPath),
    join(consumerRoot, 'node_modules', 'undici-types'),
    { recursive: true },
  );
  const requireFromRepositoryTypeScript = createRequire(requireFromRepository.resolve('typescript/package.json'));
  const installedTypeScriptManifestPath = await realpath(
    join(consumerRoot, 'node_modules', 'typescript', 'package.json'),
  );
  const requireFromInstalledTypeScript = createRequire(installedTypeScriptManifestPath);
  const sourcePlatformManifestPath = requireFromRepositoryTypeScript.resolve(`${platformPackageName}/package.json`);
  const installedPlatformManifestPath = requireFromInstalledTypeScript.resolve(`${platformPackageName}/package.json`);
  const sourcePlatformManifest = JSON.parse(await readFile(sourcePlatformManifestPath, 'utf8')) as Readonly<{
    name?: unknown;
    version?: unknown;
  }>;
  const installedPlatformManifest = JSON.parse(await readFile(installedPlatformManifestPath, 'utf8')) as Readonly<{
    name?: unknown;
    version?: unknown;
  }>;
  if (sourcePlatformManifest.name !== platformPackageName || sourcePlatformManifest.version !== '7.0.2'
      || installedPlatformManifest.name !== platformPackageName || installedPlatformManifest.version !== '7.0.2') {
    throw new Error('Packed CI Input Proof installed an unexpected TypeScript platform package.');
  }
  const binaryName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
  const sourceBinaryPath = join(dirname(sourcePlatformManifestPath), 'lib', binaryName);
  const installedBinaryPath = join(dirname(installedPlatformManifestPath), 'lib', binaryName);
  const sourceBinary = await readFile(sourceBinaryPath);
  const installedBinary = await readFile(installedBinaryPath);
  if (!sourceBinary.equals(installedBinary)) {
    throw new Error('Packed CI Input Proof installed TypeScript platform bytes differ from the repository toolchain.');
  }
  await chmod(installedBinaryPath, (await stat(sourceBinaryPath)).mode);
  return Object.freeze({ typescriptPlatforms: Object.freeze([platformPackageName]) });
}

async function installPackedCiInputProofToolchain(
  artifact: PackedArtifact,
  temporaryRoot: string,
  repositoryRoot: string,
  consumerRoot: string,
  runPnpm: RunPnpm,
): Promise<InstalledToolchainEvidence> {
  const toolchain = await packInstalledTypeScript(
    temporaryRoot,
    repositoryRoot,
    runPnpm,
  );
  const installStarted = performance.now();
  await runPnpm([
    'add',
    '--save-dev',
    '--save-exact',
    '--offline',
    '--store-dir',
    join(temporaryRoot, 'pnpm-store-TEST'),
    toolchain.platformArchiveSpecifier,
  ], consumerRoot);
  await writeFile(
    join(consumerRoot, 'pnpm-workspace.yaml'),
    `overrides:\n  ${JSON.stringify(toolchain.platformPackageName)}: ${JSON.stringify(toolchain.platformArchiveSpecifier)}\n`,
    'utf8',
  );
  await runPnpm([
    'add',
    '--save-dev',
    '--save-exact',
    '--offline',
    '--store-dir',
    join(temporaryRoot, 'pnpm-store-TEST'),
    toolchain.typescriptArchiveSpecifier,
    artifact.archiveFileSpecifier,
  ], consumerRoot);
  const installMs = performance.now() - installStarted;
  const installedManifest = JSON.parse(await readFile(
    join(consumerRoot, 'node_modules', '@agent-teams', 'ci-input-proof', 'package.json'),
    'utf8',
  )) as Readonly<{ name?: unknown; version?: unknown }>;
  if (installedManifest.name !== artifact.packageName
      || installedManifest.version !== artifact.packageVersion) {
    throw new Error('Packed CI Input Proof installed artifact identity contradicts the source manifest.');
  }
  const typeSupport = await copyInstalledTypeSupport(
    repositoryRoot,
    consumerRoot,
    toolchain.platformPackageName,
  );
  const installedTypescriptManifest = JSON.parse(await readFile(
    join(consumerRoot, 'node_modules', 'typescript', 'package.json'),
    'utf8',
  )) as Readonly<{ version?: string }>;
  const installedTypesNodeManifest = JSON.parse(await readFile(
    join(consumerRoot, 'node_modules', '@types', 'node', 'package.json'),
    'utf8',
  )) as Readonly<{ version?: string }>;
  if (installedTypescriptManifest.version !== '7.0.2'
      || installedTypesNodeManifest.version !== '24.13.3') {
    throw new Error('Packed CI Input Proof installed TypeScript toolchain is not the exact supported pin.');
  }
  return Object.freeze({
    installMs,
    installedTypesNode: installedTypesNodeManifest.version,
    installedTypescript: installedTypescriptManifest.version,
    typescriptPlatforms: typeSupport.typescriptPlatforms,
  });
}

export async function verifyPackedCiInputProof(
  artifact: PackedArtifact,
  temporaryRoot: string,
  repositoryRoot: string,
  runPnpm: RunPnpm,
): Promise<PackedCiInputProofEvidence> {
  const started = performance.now();
  const temporaryRootPath = resolve(temporaryRoot);
  const manifestPath = join(repositoryRoot, 'packages', 'ci-input-proof', 'package.json');
  const sourceManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Readonly<{
    name?: unknown;
    version?: unknown;
  }>;
  const archivePath = resolve(artifact.archivePath);
  const archiveSpecifierPath = artifact.archiveFileSpecifier.startsWith('file:')
    ? resolve(artifact.archiveFileSpecifier.slice('file:'.length))
    : null;
  const custodyPath = relative(temporaryRootPath, archivePath);
  if (sourceManifest.name !== '@agent-teams/ci-input-proof'
      || typeof sourceManifest.version !== 'string'
      || sourceManifest.version.length === 0
      || artifact.packageName !== sourceManifest.name
      || artifact.packageVersion !== sourceManifest.version
      || archiveSpecifierPath !== archivePath
      || custodyPath === ''
      || custodyPath.startsWith('..')
      || isAbsolute(custodyPath)) {
    throw new Error('Packed CI Input Proof artifact identity or custody path is invalid.');
  }
  const consumerRoot = await mkdtemp(join(resolve(temporaryRoot), 'ci-input-proof-installed-TEST-'));
  await writeJson(join(consumerRoot, 'package.json'), {
    name: 'ci-input-proof-installed-TEST',
    version: '0.0.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@11.20.0',
    devDependencies: {},
  });
  const installedToolchain = await installPackedCiInputProofToolchain(
    artifact,
    temporaryRoot,
    repositoryRoot,
    consumerRoot,
    runPnpm,
  );  await writePackedCiInputProofHarness(consumerRoot, repositoryRoot);

  const typecheckStarted = performance.now();
  const compilerVersion = await runPnpm(['exec', 'tsc', '--version'], consumerRoot);
  if (compilerVersion.stdout.trim() !== 'Version 7.0.2') {
    throw new Error('Packed CI Input Proof consumer resolved a compiler other than TypeScript 7.0.2.');
  }
  await runPnpm(['exec', 'tsc', '--project', join(consumerRoot, 'tsconfig.json')], consumerRoot);
  const typecheckMs = performance.now() - typecheckStarted;
  const conformanceStarted = performance.now();
  const conformance = await runPnpm([
    'exec',
    'node',
    join(consumerRoot, 'adapter-conformance.TEST.mts'),
  ], consumerRoot);
  const conformanceMs = performance.now() - conformanceStarted;
  const parsed = JSON.parse(conformance.stdout) as Readonly<{
    status: string;
    cases: readonly string[];
    timingsMs: Readonly<Record<string, Readonly<{
      comparison: number;
      optimizer: number;
      full: number;
      total: number;
      clock: string;
    }>>>;
  }>;
  const expectedCases = Object.freeze([
    'positive-full-pass',
    'closed-drift-full-pass',
    'incomplete-full-pass',
    'scope-drift-full-pass',
    'optimizer-unavailable-full-failed-nonzero',
    'signal-full-failed-nonzero',
    'timeout-full-failed-nonzero',
    'timeout-descendant-tree-cleaned',
    'timeout-escalation-full-failed-nonzero',
  ]);
  if (parsed.status !== 'passed'
      || JSON.stringify(parsed.cases) !== JSON.stringify(expectedCases)) {
    throw new Error('Packed CI Input Proof conformance did not complete every real-process case.');
  }
  const evidence: PackedCiInputProofEvidence = Object.freeze({
    status: 'passed',
    packageName: artifact.packageName,
    packageVersion: artifact.packageVersion,
    cases: Object.freeze([...parsed.cases]),
    typedPublicRoot: true,
    deepImportRejected: true,
    facts: Object.freeze({
      archiveFile: artifact.archivePath,
      archiveSha512: createHash('sha512').update(await readFile(archivePath)).digest('hex'),
      node: process.version,
      pnpm: '11.20.0',
      typescriptCompiler: compilerVersion.stdout.trim(),
      installedTypescript: installedToolchain.installedTypescript,
      installedTypesNode: installedToolchain.installedTypesNode,
      typescriptPlatforms: installedToolchain.typescriptPlatforms,
    }),
    processTimingsMs: Object.freeze({ ...parsed.timingsMs }),
    timingsMs: Object.freeze({
      install: installedToolchain.installMs,
      typecheck: typecheckMs,
      conformance: conformanceMs,
      total: performance.now() - started,
    }),
  });
  process.stdout.write(`Packed CI Input Proof installed conformance PASS: ${JSON.stringify(evidence)}\n`);
  return evidence;
}
