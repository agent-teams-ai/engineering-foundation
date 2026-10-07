import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import fsPromises, { readFile, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ManagedPnpmInstallInput,
  ManagedPnpmInstallResult
} from '../dist/consumer-integration/application/ports/managed-runtime.js';
import {
  pack,
  runInstall,
  runtimeLanes,
  setupInstallation,
  sha
} from './managed-runtime-corrective-helpers.mts';
import type {
  InstallationFixture,
  TarballManifest
} from './managed-runtime-corrective-helpers.mts';

interface ParentEnvironmentPackage extends TarballManifest {
  engines: Readonly<{ node: string }>;
  peerDependencies: Readonly<Record<string, string>>;
  scripts: Readonly<Record<string, string>>;
}

type InstallSpawnInvocation = [
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions
];

interface EffectiveInstallSpawn {
  command: string;
  shell: SpawnOptions['shell'];
  environment: NodeJS.ProcessEnv | undefined;
}

interface InstallEnvironmentObserver {
  spawns: readonly EffectiveInstallSpawn[];
  restore(): void;
}

function isInstallSpawnArguments(
  value: readonly string[] | SpawnOptions | undefined
): value is readonly string[] {
  return Array.isArray(value);
}

/** Observe the real launch while forwarding every supported spawn overload. */
function observeInstallEnvironments(): InstallEnvironmentObserver {
  const originalSpawn = childProcess.spawn;
  const spawns: EffectiveInstallSpawn[] = [];
  const handler: ProxyHandler<typeof childProcess.spawn> = {
    apply(
      target: typeof childProcess.spawn,
      _receiver: object | undefined,
      args: InstallSpawnInvocation
    ): ChildProcess {
      const [command, argsOrOptions, suppliedOptions] = args;
      const options: SpawnOptions | undefined = isInstallSpawnArguments(argsOrOptions)
        ? suppliedOptions
        : argsOrOptions;
      spawns.push({
        command,
        shell: options?.shell,
        environment: options?.env === undefined ? undefined : { ...options.env }
      });
      if (isInstallSpawnArguments(argsOrOptions)) {
        return options === undefined
          ? target(command, argsOrOptions)
          : target(command, argsOrOptions, options);
      }
      return argsOrOptions === undefined
        ? target(command)
        : target(command, argsOrOptions);
    }
  };
  childProcess.spawn = new Proxy(originalSpawn, handler);
  syncBuiltinESMExports();
  return {
    spawns,
    restore(): void {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  };
}

function assertEffectiveInstallEnvironments(
  spawns: readonly EffectiveInstallSpawn[],
  selectedNode: string,
  parentSettings: Readonly<Record<string, string>>
): void {
  assert.ok(spawns.length > 0, 'the actual managed installation launched a child');
  for (const [key, value] of Object.entries(parentSettings)) {
    assert.equal(process.env[key], value, `the conflicting parent ${key} remains present`);
  }
  for (const spawn of spawns) {
    assert.equal(spawn.command, selectedNode);
    assert.equal(spawn.shell, false);
    const environment = spawn.environment;
    assert.ok(environment, 'every managed child receives an explicit environment');
    assert.equal(environment.npm_config_engine_strict, 'true');
    assert.equal(environment.npm_config_strict_peer_dependencies, 'true');
    assert.equal(environment.npm_config_manage_package_manager_versions, 'false');
    for (const [key, value] of Object.entries(parentSettings)) {
      assert.notEqual(environment[key], value, `${key} must not inherit its parent value`);
    }
    for (const key of [
      'NODE_OPTIONS', 'NODE_PATH', 'npm_config_node_options',
      'npm_config_use_node_version', 'TEST_PARENT_ENVIRONMENT_SENTINEL'
    ]) {
      assert.equal(environment[key], undefined, `${key} is absent from the managed child`);
    }
  }
}

for (const lane of runtimeLanes) {
  test(`${lane}: real prepare and frozen installs isolate conflicting parent settings and retain pnpm strictness`, async () => {
    const scenarios: readonly ('valid' | 'engine' | 'peer')[] = ['valid', 'engine', 'peer'];
    for (const scenario of scenarios) {
      const x: InstallationFixture = await setupInstallation(
        lane, `${lane}: actual parent-environment isolation ${scenario}`
      );
      const observer: InstallEnvironmentObserver = observeInstallEnvironments();
      const previous = new Map<string, string | undefined>();
      const parentSettings: Readonly<Record<string, string>> & {
        readonly npm_config_store_dir: string;
      } = {
        NODE_OPTIONS: '--TEST-parent-node-option-must-not-be-forwarded',
        NODE_PATH: join(x.f.root, 'TEST-parent-module-path'),
        npm_config_node_options: '--TEST-parent-node-option-must-not-be-forwarded',
        npm_config_use_node_version: '99.0.0',
        npm_config_engine_strict: 'false',
        NPM_CONFIG_ENGINE_STRICT: 'false',
        npm_config_strict_peer_dependencies: 'false',
        NPM_CONFIG_STRICT_PEER_DEPENDENCIES: 'false',
        npm_config_auto_install_peers: 'true',
        npm_config_manage_package_manager_versions: 'true',
        npm_config_verify_store_integrity: 'false',
        npm_config_ignore_scripts: 'false',
        npm_config_offline: 'false',
        npm_config_store_dir: join(x.f.root, 'TEST-parent-pnpm-store'),
        npm_config_userconfig: join(x.f.root, 'TEST-parent-user.npmrc'),
        npm_config_globalconfig: join(x.f.root, 'TEST-parent-global.npmrc'),
        TEST_PARENT_ENVIRONMENT_SENTINEL: 'TEST-parent-only-value'
      };
      try {
        const peerManifest: TarballManifest = {
          name: 'parent-env-peer', version: '1.0.0', main: 'index.js'
        };
        const packageManifest: ParentEnvironmentPackage = {
          name: 'parent-env-consumer', version: '1.0.0', main: 'index.js',
          engines: { node: scenario === 'engine' ? '>=99' : '>=24 <27' },
          peerDependencies: {
            'parent-env-peer': scenario === 'peer' ? '^2.0.0' : '^1.0.0'
          },
          scripts: { preinstall: 'touch TEST-parent-hook-ran' }
        };
        const peer = await pack(x.root, peerManifest.name, peerManifest);
        const dependency = await pack(x.root, packageManifest.name, packageManifest);
        const manifest = JSON.stringify({
          name: 'test-managed-install', version: '1.0.0', private: true,
          packageManager: 'pnpm@11.20.0',
          dependencies: {
            'parent-env-peer': peer,
            'parent-env-consumer': dependency
          }
        }) + '\n';
        await writeFile(join(x.root, 'package.json'), manifest);
        const input: ManagedPnpmInstallInput = {
          ...x.input, expectedManifestDigest: sha(manifest)
        };
        for (const [key, value] of Object.entries(parentSettings)) {
          previous.set(key, process.env[key]);
          process.env[key] = value;
        }
        const prepareStart = observer.spawns.length;
        const first: ManagedPnpmInstallResult = await runInstall(x, input);
        assertEffectiveInstallEnvironments(
          observer.spawns.slice(prepareStart), x.f.node, parentSettings
        );
        assert.equal(first.facts.spawned, true);
        assert.equal(first.facts.directChild, 'reaped');
        assert.equal(first.facts.group, 'empty-observed');
        assert.equal(first.facts.streams, 'closed');
        await assert.rejects(stat(parentSettings.npm_config_store_dir), { code: 'ENOENT' });
        if (scenario !== 'valid') {
          assert.ok(first.outcome === 'refused', JSON.stringify(first));
          assert.equal(first.code, 'process-failed');
          assert.notEqual(first.facts.exitCode, 0);
          assert.equal(first.debt, null);
          const diagnosticTailBase64 = first.diagnosticTailBase64;
          assert.ok(
            typeof diagnosticTailBase64 === 'string' && diagnosticTailBase64.length > 0,
            'engine and required-peer refusals must retain nonempty diagnostics'
          );
          assert.match(
            Buffer.from(diagnosticTailBase64, 'base64').toString(),
            scenario === 'engine' ? /ERR_PNPM_UNSUPPORTED_ENGINE/ : /ERR_PNPM_PEER_DEP_ISSUES/
          );
          assert.deepEqual(await x.scope.close(), { outcome: 'closed' });
          continue;
        }
        assert.ok(first.outcome === 'installed', JSON.stringify(first));
        assert.equal(first.runtime.tuple.nodeVersion, x.f.expected.nodeVersion);
        assert.equal(first.runtime.tuple.pnpmVersion, '11.20.0');
        assert.equal(sha(await readFile(join(x.root, 'package.json'))), input.expectedManifestDigest);
        assert.ok((await stat(join(x.root, '.managed-pnpm-store'))).isDirectory());
        const installedPackages = new Map<string, Buffer>();
        for (const body of [peerManifest, packageManifest]) {
          const bytes = await readFile(join(x.root, 'node_modules', body.name, 'package.json'));
          const installedManifest: unknown = JSON.parse(bytes.toString('utf8'));
          assert.deepEqual(installedManifest, body);
          installedPackages.set(body.name, bytes);
        }
        const hook = join(x.root, 'node_modules/parent-env-consumer/TEST-parent-hook-ran');
        await assert.rejects(readFile(hook), { code: 'ENOENT' });
        const rootLock = await readFile(join(x.root, 'pnpm-lock.yaml'));
        const virtualLock = await readFile(join(x.root, 'node_modules/.pnpm/lock.yaml'));
        assert.equal(sha(rootLock), first.lockDigest);
        assert.equal(sha(virtualLock), first.virtualStoreLockDigest);
        await fsPromises.rm(join(x.root, 'node_modules'), { recursive: true });
        const frozenStart = observer.spawns.length;
        const replay: ManagedPnpmInstallResult = await runInstall(x, {
          ...input, mode: 'frozen-offline', expectedLockDigest: sha(rootLock)
        });
        assertEffectiveInstallEnvironments(
          observer.spawns.slice(frozenStart), x.f.node, parentSettings
        );
        assert.ok(replay.outcome === 'installed', JSON.stringify(replay));
        assert.equal(replay.facts.spawned, true);
        assert.equal(replay.facts.directChild, 'reaped');
        assert.equal(replay.facts.group, 'empty-observed');
        assert.equal(replay.facts.streams, 'closed');
        assert.equal(replay.runtime.tuple.nodeVersion, x.f.expected.nodeVersion);
        assert.equal(replay.runtime.tuple.pnpmVersion, '11.20.0');
        assert.equal(replay.lockDigest, sha(rootLock));
        assert.equal(replay.virtualStoreLockDigest, sha(virtualLock));
        assert.deepEqual(await readFile(join(x.root, 'pnpm-lock.yaml')), rootLock);
        assert.deepEqual(await readFile(join(x.root, 'node_modules/.pnpm/lock.yaml')), virtualLock);
        for (const [name, bytes] of installedPackages) {
          assert.deepEqual(await readFile(join(x.root, 'node_modules', name, 'package.json')), bytes);
        }
        assert.equal(sha(await readFile(join(x.root, 'package.json'))), input.expectedManifestDigest);
        await assert.rejects(readFile(hook), { code: 'ENOENT' });
        await assert.rejects(stat(parentSettings.npm_config_store_dir), { code: 'ENOENT' });
        assert.deepEqual(await x.scope.close(), { outcome: 'closed' });
      } finally {
        observer.restore();
        for (const [key, value] of previous) {
          if (value === undefined) {delete process.env[key];}
          else {process.env[key] = value;}
        }
        await x.scope.close();
        await x.f.cleanup();
      }
    }
  });
}
