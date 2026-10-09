import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  runCiInputProofAdapter,
  type CompareInputInventories,
  type FoundationPilotRequest,
  type InputLeafShape,
  type MergeTuple,
  type Observation,
  type ScopeCategory,
} from './ci-input-proof-foundation-adapter.mts';

type ScopeInput = Readonly<{ logicalPath: string; sourcePath: string | null }>;
type Scope = Readonly<Record<ScopeCategory, readonly ScopeInput[]>>;
type CollectionReport = Readonly<{
  boundaryId: string;
  scopeId: 'foundation.ci-input-proof.focus.v1';
  facts: number;
  categories: Readonly<Record<ScopeCategory, readonly string[]>>;
  closureBasis: 'fixed-export-files-zero-runtime-dependencies';
  admission: 'control-shadow-only';
  durationMs: number;
  clock: 'performance.now';
}>;
type FoundationPilotResult = Readonly<{
  collections: Readonly<{ before: CollectionReport; current: CollectionReport }>;
  collectionIssues: readonly string[];
  comparisonBasis: 'same-tree-two-boundary-control-shadow';
  timingObservation: Readonly<{
    collectionOverheadMs: number;
    potentialAvoidedFullMs: number | null;
    avoidedWorkAuthority: false;
  }>;
  adapter: Awaited<ReturnType<typeof runCiInputProofAdapter>>;
}>;

const scope: Scope = Object.freeze({
  source: Object.freeze([
    { logicalPath: 'packages/ci-input-proof/src/index.ts', sourcePath: 'packages/ci-input-proof/src/index.ts' },
    {
      logicalPath: 'packages/ci-input-proof/src/features/input-comparison/application/compare-leaf-inventories.ts',
      sourcePath: 'packages/ci-input-proof/src/features/input-comparison/application/compare-leaf-inventories.ts',
    },
  ]),
  helpers: Object.freeze([
    { logicalPath: 'scripts/ci-input-proof-full.mts', sourcePath: 'scripts/ci-input-proof-full.mts' },
    { logicalPath: 'scripts/ci-input-proof-foundation-adapter.mts', sourcePath: 'scripts/ci-input-proof-foundation-adapter.mts' },
    { logicalPath: 'scripts/ci-input-proof-foundation-pilot.mts', sourcePath: 'scripts/ci-input-proof-foundation-pilot.mts' },
    { logicalPath: 'scripts/packed-ci-input-proof.mts', sourcePath: 'scripts/packed-ci-input-proof.mts' },
    { logicalPath: 'scripts/ci-input-proof-packed-harness.mts', sourcePath: 'scripts/ci-input-proof-packed-harness.mts' },
    { logicalPath: 'scripts/pack-test.mjs', sourcePath: 'scripts/pack-test.mjs' },
    { logicalPath: 'scripts/prepare-ci-input-proof-rc.mts', sourcePath: 'scripts/prepare-ci-input-proof-rc.mts' },
    { logicalPath: 'tests/support/ci-input-proof-donor-cases.mts', sourcePath: 'tests/support/ci-input-proof-donor-cases.mts' },
  ]),
  fixtures: Object.freeze([
    { logicalPath: 'tests/features/input-comparison/ci-input-proof.test.mts', sourcePath: 'tests/features/input-comparison/ci-input-proof.test.mts' },
    { logicalPath: 'tests/ci-input-proof-rc.test.mts', sourcePath: 'tests/ci-input-proof-rc.test.mts' },
    { logicalPath: 'tests/fixtures/ci-input-proof/foundation-pilot.TEST.mts', sourcePath: 'tests/fixtures/ci-input-proof/foundation-pilot.TEST.mts' },
  ]),
  config: Object.freeze([
    { logicalPath: '.changeset/config.json', sourcePath: '.changeset/config.json' },
    { logicalPath: 'architecture/foundation/feature-modules.json', sourcePath: 'architecture/foundation/feature-modules.json' },
    { logicalPath: 'foundation.config.yaml', sourcePath: 'foundation.config.yaml' },
    { logicalPath: 'LICENSE', sourcePath: 'LICENSE' },
    { logicalPath: 'packages/ci-input-proof/CHANGELOG.md', sourcePath: 'packages/ci-input-proof/CHANGELOG.md' },
    { logicalPath: 'packages/ci-input-proof/LICENSE', sourcePath: 'packages/ci-input-proof/LICENSE' },
    { logicalPath: 'packages/ci-input-proof/README.md', sourcePath: 'packages/ci-input-proof/README.md' },
    { logicalPath: 'packages/ci-input-proof/tsconfig.json', sourcePath: 'packages/ci-input-proof/tsconfig.json' },
    { logicalPath: 'tests/manifests/test-shards.v1.json', sourcePath: 'tests/manifests/test-shards.v1.json' },
    { logicalPath: 'tests/manifests/windows-lanes.v1.json', sourcePath: 'tests/manifests/windows-lanes.v1.json' },
    { logicalPath: 'tsconfig.json', sourcePath: 'tsconfig.json' },
    { logicalPath: 'tsconfig.ci-tooling.json', sourcePath: 'tsconfig.ci-tooling.json' },
  ]),
  lock: Object.freeze([
    { logicalPath: 'package.json', sourcePath: 'package.json' },
    { logicalPath: 'pnpm-lock.yaml', sourcePath: 'pnpm-lock.yaml' },
    { logicalPath: 'pnpm-workspace.yaml', sourcePath: 'pnpm-workspace.yaml' },
  ]),
  toolchain: Object.freeze([
    { logicalPath: '.node-version', sourcePath: '.node-version' },
    { logicalPath: '.npmrc', sourcePath: '.npmrc' },
    { logicalPath: 'toolchain/node-executable', sourcePath: null },
    { logicalPath: 'toolchain/runtime-facts', sourcePath: null },
  ]),
  installedGraph: Object.freeze([
    { logicalPath: 'node_modules/.package-map.json', sourcePath: 'node_modules/.package-map.json' },
    { logicalPath: 'node_modules/.pnpm/lock.yaml', sourcePath: 'node_modules/.pnpm/lock.yaml' },
    { logicalPath: 'packages/ci-input-proof/package.json', sourcePath: 'packages/ci-input-proof/package.json' },
    { logicalPath: 'packages/ci-input-proof/dist/index.js', sourcePath: 'packages/ci-input-proof/dist/index.js' },
    { logicalPath: 'packages/ci-input-proof/dist/index.d.ts', sourcePath: 'packages/ci-input-proof/dist/index.d.ts' },
    { logicalPath: 'packages/ci-input-proof/dist/index.js.map', sourcePath: 'packages/ci-input-proof/dist/index.js.map' },
    { logicalPath: 'packages/ci-input-proof/dist/index.d.ts.map', sourcePath: 'packages/ci-input-proof/dist/index.d.ts.map' },
    {
      logicalPath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js',
      sourcePath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js',
    },
    {
      logicalPath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts',
      sourcePath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts',
    },
    {
      logicalPath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js.map',
      sourcePath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.js.map',
    },
    {
      logicalPath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts.map',
      sourcePath: 'packages/ci-input-proof/dist/features/input-comparison/application/compare-leaf-inventories.d.ts.map',
    },
  ]),
});

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const unavailableCompare: CompareInputInventories = () => {
  throw new Error('comparator-import-unavailable');
};

function runtimeFacts(): string {
  return JSON.stringify({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    v8: process.versions.v8,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    ci: process.env.CI ?? '',
    nodeEnvironment: process.env.NODE_ENV ?? '',
  });
}

async function collectLeaf(repositoryRoot: string, input: ScopeInput): Promise<InputLeafShape> {
  const sourcePath = input.sourcePath === null
    ? input.logicalPath === 'toolchain/node-executable' ? process.execPath : null
    : resolve(repositoryRoot, input.sourcePath);
  if (input.logicalPath === 'toolchain/runtime-facts') {
    return Object.freeze({
      path: input.logicalPath,
      type: 'file',
      mode: '100644',
      membership: 'closed',
      content: digest(runtimeFacts()),
    });
  }
  if (sourcePath === null) {
    throw new Error(`unsupported synthetic input ${input.logicalPath}`);
  }
  const stat = await lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`unsupported symlink target closure ${input.logicalPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`scope input is not a file or symlink ${input.logicalPath}`);
  }
  const bytes = await readFile(sourcePath);
  if (input.logicalPath === 'packages/ci-input-proof/package.json') {
    const parsedManifest: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof parsedManifest !== 'object' || parsedManifest === null || Array.isArray(parsedManifest)) {
      throw new Error('package manifest is malformed');
    }
    const manifest = parsedManifest as Readonly<{
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    }>;
    const installedDependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    if (installedDependencies.length > 0) {
      throw new Error(`unsupported installed dependency graph ${installedDependencies.join(',')}`);
    }
  }
  return Object.freeze({
    path: input.logicalPath,
    type: 'file',
    mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
    membership: input.logicalPath === 'packages/ci-input-proof/src/index.ts' ? 'structural' : 'closed',
    content: digest(bytes),
  });
}

export async function collectFoundationPilotObservation(
  repositoryRoot: string,
  boundaryId: string,
): Promise<Readonly<{ observation: Observation; collection: CollectionReport }>> {
  const started = performance.now();
  const categories = Object.fromEntries(
    Object.entries(scope).map(([category, inputs]) => [category, Object.freeze(inputs.map(input => input.logicalPath))]),
  ) as Record<ScopeCategory, readonly string[]>;
  const inputs = Object.values(scope).flat();
  const leaves = await Promise.all(inputs.map(input => collectLeaf(repositoryRoot, input)));
  leaves.sort((left, right) => left.path.localeCompare(right.path));
  const observation: Observation = Object.freeze({
    schemaVersion: 1,
    boundaryId,
    scopeId: 'foundation.ci-input-proof.focus.v1',
    scope: Object.freeze(categories),
    inventory: Object.freeze({
      version: 1,
      digestScheme: 'sha256',
      inputs: Object.freeze(leaves),
    }),
  });
  const collection: CollectionReport = Object.freeze({
    boundaryId,
    scopeId: 'foundation.ci-input-proof.focus.v1',
    facts: leaves.length,
    categories: Object.freeze(categories),
    closureBasis: 'fixed-export-files-zero-runtime-dependencies' as const,
    admission: 'control-shadow-only' as const,
    durationMs: performance.now() - started,
    clock: 'performance.now' as const,
  });
  return Object.freeze({ observation, collection });
}

export function foundationPilotRequest(
  before: Observation,
  current: Observation,
  tuple: MergeTuple,
): FoundationPilotRequest {
  return Object.freeze({
    schemaVersion: 1,
    pilotId: 'foundation.ci-input-proof.focus.v1',
    tuple,
    before,
    current,
    permittedContentChanges: Object.freeze([]),
    full: Object.freeze({
      command: process.execPath,
      args: Object.freeze(['--test', 'tests/ci-input-proof-rc.test.mts']),
      cwd: resolve(process.cwd()),
      timeoutMs: 180_000,
    }),
  });
}

export async function runFoundationCiInputProofPilot(tuple: MergeTuple): Promise<FoundationPilotResult> {
  const repositoryRoot = resolve(process.cwd());
  const beforeResult = await attemptCollection(repositoryRoot, 'before-observation');
  const currentResult = await attemptCollection(repositoryRoot, 'current-observation');
  const collectionIssues: string[] = [];
  if (beforeResult.status === 'failed') {
    collectionIssues.push(`before:${beforeResult.issue}`);
  }
  if (currentResult.status === 'failed') {
    collectionIssues.push(`current:${currentResult.issue}`);
  }
  const before = beforeResult.status === 'passed'
    ? beforeResult.collection
    : unavailableCollection('before-observation');
  const current = currentResult.status === 'passed'
    ? currentResult.collection
    : unavailableCollection('current-observation');
  let compare = unavailableCompare;
  try {
    const comparator = await import(new URL('../packages/ci-input-proof/dist/index.js', import.meta.url).href) as {
      compareLeafInventories: CompareInputInventories;
    };
    compare = comparator.compareLeafInventories;
  } catch {
    collectionIssues.push('comparator:import-unavailable');
  }
  const adapter = await runCiInputProofAdapter(
    foundationPilotRequest(before.observation, current.observation, tuple),
    compare,
  );
  return Object.freeze({
    collections: Object.freeze({ before: before.collection, current: current.collection }),
    collectionIssues: Object.freeze([...collectionIssues]),
    comparisonBasis: 'same-tree-two-boundary-control-shadow' as const,
    timingObservation: Object.freeze({
      collectionOverheadMs: before.collection.durationMs + current.collection.durationMs,
      potentialAvoidedFullMs: adapter.report.candidateOmitObservation.status === 'eligible'
        ? adapter.report.timingsMs.full
        : null,
      avoidedWorkAuthority: false as const,
    }),
    adapter,
  });
}

async function attemptCollection(
  repositoryRoot: string,
  boundaryId: string,
): Promise<
  | Readonly<{ status: 'passed'; collection: Awaited<ReturnType<typeof collectFoundationPilotObservation>> }>
  | Readonly<{ status: 'failed'; issue: string }>
> {
  try {
    return Object.freeze({
      status: 'passed' as const,
      collection: await collectFoundationPilotObservation(repositoryRoot, boundaryId),
    });
  } catch (error) {
    return Object.freeze({ status: 'failed' as const, issue: failureCode(error) });
  }
}

function failureCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'collection-failed';
}

function unavailableCollection(
  boundaryId: string,
): Readonly<{ observation: Observation; collection: CollectionReport }> {
  const categories = Object.freeze({
    source: Object.freeze([]),
    helpers: Object.freeze([]),
    fixtures: Object.freeze([]),
    config: Object.freeze([]),
    lock: Object.freeze([]),
    toolchain: Object.freeze([]),
    installedGraph: Object.freeze([]),
  });
  return Object.freeze({
    observation: Object.freeze({
      schemaVersion: 1,
      boundaryId,
      scopeId: 'foundation.ci-input-proof.focus.v1',
      scope: categories,
      inventory: Object.freeze({ version: 1, digestScheme: 'sha256', inputs: Object.freeze([]) }),
    }),
    collection: Object.freeze({
      boundaryId,
      scopeId: 'foundation.ci-input-proof.focus.v1',
      facts: 0,
      categories,
      closureBasis: 'fixed-export-files-zero-runtime-dependencies' as const,
      admission: 'control-shadow-only' as const,
      durationMs: 0,
      clock: 'performance.now' as const,
    }),
  });
}

function argument(name: string, argv: readonly string[]): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(argv: readonly string[]): Promise<void> {
  const tuple: MergeTuple = Object.freeze({
    headSha: argument('--head', argv),
    baseSha: argument('--base', argv),
    mergeTuple: argument('--merge', argv),
  });
  const result = await runFoundationCiInputProofPilot(tuple);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.adapter.exitCode;
}

const entry = process.argv.at(1);
const invoked = entry === undefined ? undefined : pathToFileURL(resolve(entry)).href;
if (invoked === import.meta.url) {
  await main(process.argv.slice(2));
}
