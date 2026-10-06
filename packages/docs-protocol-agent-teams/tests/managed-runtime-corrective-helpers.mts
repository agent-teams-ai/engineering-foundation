import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, parent } from './managed-runtime-fixtures.mjs';
import type { ManagedRuntimeFixture } from './managed-runtime-fixtures.mjs';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';
import type {
  AttemptAcquisition,
  ManagedAttemptInput,
  ManagedPnpmInstallInput,
  ManagedPnpmInstallResult,
  RuntimeRefusalCode
} from '../dist/consumer-integration/application/ports/managed-runtime.js';

export type RuntimeLane = 'node24' | 'node26';
export const runtimeLanes: readonly RuntimeLane[] = ['node24', 'node26'];
export type ManagedRuntimeScope = ReturnType<typeof createNodeManagedRuntimeScope>;
export type AcquiredAttempt = Extract<AttemptAcquisition, { outcome: 'acquired' }>;

export interface PreparedRuntime {
  f: ManagedRuntimeFixture;
  scope: ManagedRuntimeScope;
  attemptInput: ManagedAttemptInput;
}

export interface InstallEvidenceFixture {
  f: ManagedRuntimeFixture;
  scope: ManagedRuntimeScope;
  root: string;
  scenario: string;
}

export interface InstallationFixture extends PreparedRuntime, InstallEvidenceFixture {
  acquisition: AcquiredAttempt;
  input: ManagedPnpmInstallInput;
}

export function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function prepareRuntime(lane: RuntimeLane): Promise<PreparedRuntime> {
  const f: ManagedRuntimeFixture = await fixture(lane);
  const external = join(f.root, 'TEST-attempt-records');
  const consumer = join(f.root, 'TEST-consumer');
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal
  });
  try {
    await Promise.all([mkdir(external), mkdir(consumer)]);
    const admission = await scope.admit();
    assert.ok(admission.outcome === 'admitted', JSON.stringify(admission));
    const attemptInput: ManagedAttemptInput = {
      externalRoot: external,
      consumerRoot: consumer,
      controllerBuildDigest: '1'.repeat(64),
      role: 'source',
      runtime: admission.runtime,
      signal
    };
    return { f, scope, attemptInput };
  } catch (error) {
    await scope.close();
    await f.cleanup();
    throw error;
  }
}

export async function setupInstallation(
  lane: RuntimeLane,
  scenario: string
): Promise<InstallationFixture> {
  const x = await prepareRuntime(lane);
  try {
    const acquisition: AttemptAcquisition = await x.scope.acquireAttempt(x.attemptInput);
    assert.ok(acquisition.outcome === 'acquired', JSON.stringify(acquisition));
    const root = acquisition.attempt.ownedRoot;
    const manifest = JSON.stringify({
      name: 'test-managed-install',
      version: '1.0.0',
      private: true,
      packageManager: 'pnpm@11.20.0',
      dependencies: {}
    }) + '\n';
    const workspace = 'packages: []\n';
    await writeFile(join(root, 'package.json'), manifest);
    await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
    const handle = x.scope.ownedInstallationRoot();
    assert.ok(handle);
    const input: ManagedPnpmInstallInput = {
      root: handle,
      runtime: x.attemptInput.runtime,
      mode: 'prepare',
      expectedManifestDigest: sha(manifest),
      expectedWorkspaceDigest: sha(workspace),
      expectedLockDigest: null,
      signal: x.attemptInput.signal
    };
    return { ...x, acquisition, root, input, scenario };
  } catch (error) {
    await x.scope.close();
    await x.f.cleanup();
    throw error;
  }
}

/** Existing installation evidence helper, including the corrected offline argv. */
export async function runInstall(
  x: InstallEvidenceFixture,
  input: ManagedPnpmInstallInput
): Promise<ManagedPnpmInstallResult> {
  const result: ManagedPnpmInstallResult = await x.scope.install(input);
  const requestedArgs: string[] = [
    'install',
    '--ignore-scripts',
    '--engine-strict',
    '--strict-peer-dependencies',
    '--config.auto-install-peers=false',
    '--config.manage-package-manager-versions=false',
    '--config.verify-store-integrity=true',
    '--package-import-method=copy',
    `--store-dir=${join(x.root, '.managed-pnpm-store')}`,
    '--offline',
    ...(input.mode === 'frozen-offline' ? ['--frozen-lockfile'] : [])
  ];
  await appendFile(join(parent, 'P2b-install-evidence.jsonl'), JSON.stringify({
    scenario: x.scenario,
    fixtureRoot: x.f.root,
    ownedRoot: x.root,
    selectedNodeSha256: x.f.trusted.nodeSha,
    pnpmTreeSha256: x.f.trusted.treeSha,
    platform: process.platform,
    architecture: process.arch,
    uid: process.getuid?.() ?? null,
    groups: process.getgroups?.() ?? [],
    mode: input.mode,
    requestedArgs,
    outcome: result.outcome,
    code: result.outcome === 'refused' ? result.code : null,
    facts: result.facts
  }) + '\n', { mode: 0o600 });
  return result;
}

export interface TarballManifest {
  name: string;
  version: string;
  main?: string;
  dependencies?: Readonly<Record<string, string>>;
}

/** Preserve the historical pack helper's dependency fixture bytes and tar invocation. */
export async function pack(
  root: string,
  name: string,
  body: TarballManifest,
  payload: Buffer | null = null
): Promise<string> {
  const dir = join(root, `TEST-package-${name}`);
  await mkdir(join(dir, 'package'), { recursive: true });
  await writeFile(join(dir, 'package/package.json'), JSON.stringify(body));
  await writeFile(join(dir, 'package/index.js'), 'export default 1;\n');
  if (payload) {
    await writeFile(join(dir, 'package/payload.bin'), payload);
  }
  const target = join(root, `${name}.tgz`);
  execFileSync('tar', ['-czf', target, '-C', dir, 'package']);
  return `file:./${name}.tgz`;
}

type SpawnInvocation = [
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions
];

function isSpawnArguments(
  value: readonly string[] | SpawnOptions | undefined
): value is readonly string[] {
  return Array.isArray(value);
}

export interface SpawnMonitor {
  count(): number;
  lastChild(): ChildProcess | null;
  restore(): void;
}

/** Preserve every public spawn overload while forwarding through typed Node calls. */
export function monitorSpawns(): SpawnMonitor {
  const originalSpawn = childProcess.spawn;
  let count = 0;
  let lastChild: ChildProcess | null = null;
  const handler: ProxyHandler<typeof childProcess.spawn> = {
    apply(
      target: typeof childProcess.spawn,
      _receiver: object | undefined,
      args: SpawnInvocation
    ): ChildProcess {
      count++;
      const [command, argsOrOptions, options] = args;
      let child: ChildProcess;
      if (isSpawnArguments(argsOrOptions)) {
        child = options === undefined
          ? target(command, argsOrOptions)
          : target(command, argsOrOptions, options);
      } else {
        child = argsOrOptions === undefined
          ? target(command)
          : target(command, argsOrOptions);
      }
      lastChild = child;
      return child;
    }
  };
  childProcess.spawn = new Proxy(originalSpawn, handler);
  syncBuiltinESMExports();
  return {
    count: () => count,
    lastChild: () => lastChild,
    restore(): void {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  };
}

export type PeerResult =
  | { outcome: 'acquired' }
  | { outcome: 'refused'; code: RuntimeRefusalCode };

const refusalCodes: readonly RuntimeRefusalCode[] = [
  'invalid-selection', 'unsupported-platform', 'unsupported-launcher',
  'runtime-mismatch', 'identity-changed', 'spawn-failed', 'cancelled',
  'deadline', 'output-limit', 'invalid-output', 'process-failed',
  'cleanup-failed', 'liveness-uncertain'
];

function isRefusalCode(value: unknown): value is RuntimeRefusalCode {
  return refusalCodes.some(code => code === value);
}

function parsePeerResult(text: string): PeerResult {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TEST peer returned a non-object result');
  }
  const keys = Reflect.ownKeys(value);
  if ('outcome' in value && value.outcome === 'acquired' && keys.length === 1) {
    return { outcome: 'acquired' };
  }
  if ('outcome' in value && value.outcome === 'refused' &&
      'code' in value && isRefusalCode(value.code) && keys.length === 2) {
    return { outcome: 'refused', code: value.code };
  }
  throw new Error('TEST peer returned an invalid acquisition result');
}

export function peerAcquisition(
  x: PreparedRuntime,
  consumerRoot: string
): PeerResult {
  const script = fileURLToPath(new URL('./managed-runtime-corrective-peer.mts', import.meta.url));
  const output = execFileSync(x.f.node, [script], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      TEST_ROOT: x.f.root,
      TEST_SELECTION: JSON.stringify(x.f.selection),
      TEST_EXTERNAL: x.attemptInput.externalRoot,
      TEST_CONSUMER: consumerRoot
    }
  });
  return parsePeerResult(output.trim());
}
