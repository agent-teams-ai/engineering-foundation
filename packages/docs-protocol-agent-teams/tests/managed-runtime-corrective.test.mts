import assert from 'node:assert/strict';
import fsPromises, { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';
import type {
  AttemptAcquisition,
  ManagedAttemptClose,
  ManagedAttemptInput,
  ManagedPnpmInstallInput,
  ManagedPnpmInstallResult
} from '../dist/consumer-integration/application/ports/managed-runtime.js';
import {
  monitorSpawns,
  pack,
  peerAcquisition,
  prepareRuntime,
  runInstall,
  runtimeLanes,
  setupInstallation,
  sha
} from './managed-runtime-corrective-helpers.mts';
import type {
  InstallationFixture,
  PreparedRuntime,
  RuntimeLane,
  SpawnMonitor
} from './managed-runtime-corrective-helpers.mts';

 type CoercionValue =
  | { toString(): string }
  | { [Symbol.toPrimitive](): never };

interface CoercionDescriptor {
  value: CoercionValue;
  enumerable: boolean;
  configurable: boolean;
  writable: boolean;
}

type UncertainDisposal = 'modified' | 'substituted' | 'sync-failed' | 'close-failed';
type Disposal = 'unchanged' | UncertainDisposal;
const uncertainDisposals: readonly UncertainDisposal[] = [
  'modified', 'substituted', 'sync-failed', 'close-failed'
];

interface ProvisionalFaultState {
  descriptor: FileHandle | null;
  closes: number;
}

async function assertProvisionalDisposal(lane: RuntimeLane, disposal: Disposal): Promise<void> {
  const x: InstallationFixture = await setupInstallation(
    lane,
    `provisional reservation disposal ${disposal} reports its actual settlement`
  );
  const external = x.attemptInput.externalRoot;
  const path = x.acquisition.attempt.evidencePath;
  const sibling = `${path}.release-debt`;
  const subject = createNodeManagedRuntimeScope({
    privateRoot: x.f.root,
    selection: x.f.selection,
    signal: x.input.signal
  });
  const originalOpen = fsPromises.open;
  const fault: ProvisionalFaultState = { descriptor: null, closes: 0 };
  let monitor: SpawnMonitor | null = null;
  try {
    assert.deepEqual(await x.acquisition.attempt.close(), { outcome: 'closed' });
    const admission = await subject.admit();
    assert.ok(admission.outcome === 'admitted', JSON.stringify(admission));
    await writeFile(sibling, 'TEST-existing-release-barrier');
    fsPromises.open = async (
      ...args: Parameters<typeof fsPromises.open>
    ): Promise<FileHandle> => {
      const fd: FileHandle = await originalOpen(...args);
      if (args[0] === path && fault.descriptor === null) {
        fault.descriptor = fd;
        const originalClose: () => Promise<void> = fd.close.bind(fd);
        fd.close = async (): Promise<void> => {
          fault.closes++;
          await originalClose();
          if (disposal === 'close-failed') {
            throw Object.assign(new Error('TEST provisional close EIO'), { code: 'EIO' });
          }
        };
        if (disposal === 'substituted') {
          await fsPromises.unlink(path);
        }
        if (disposal === 'modified' || disposal === 'substituted') {
          await writeFile(path, 'TEST-FOREIGN-PROVISIONAL');
        }
      }
      if (args[0] === external && disposal === 'sync-failed') {
        fd.sync = async (): Promise<void> => {
          throw Object.assign(new Error('TEST provisional directory sync EIO'), { code: 'EIO' });
        };
      }
      return fd;
    };
    monitor = monitorSpawns();
    const input: ManagedAttemptInput = {
      externalRoot: external,
      consumerRoot: x.attemptInput.consumerRoot,
      controllerBuildDigest: '1'.repeat(64),
      role: 'source',
      runtime: admission.runtime,
      signal: x.input.signal
    };
    const result: AttemptAcquisition = await subject.acquireAttempt(input);
    assert.ok(result.outcome === 'refused', JSON.stringify(result));
    assert.equal(monitor.count(), 0);
    assert.equal(fault.closes, 1);
    assert.ok(fault.descriptor);
    await assert.rejects(fault.descriptor.stat(), { code: 'EBADF' });
    assert.equal(await readFile(sibling, 'utf8'), 'TEST-existing-release-barrier');
    if (disposal === 'unchanged') {
      assert.equal(result.code, 'liveness-uncertain');
      assert.equal(result.debt, null);
      await assert.rejects(stat(path), { code: 'ENOENT' });
      assert.deepEqual(await subject.close(), { outcome: 'closed' });
      assert.deepEqual(await subject.close(), { outcome: 'closed' });
    } else {
      assert.equal(result.code, 'cleanup-failed');
      assert.ok(result.debt);
      assert.equal(result.debt.code, 'cleanup-failed');
      const closed: ManagedAttemptClose = await subject.close();
      assert.ok(closed.outcome === 'debt', JSON.stringify(closed));
      assert.strictEqual(closed.debt, result.debt);
      assert.deepEqual(await subject.close(), closed);
      if (disposal === 'modified' || disposal === 'substituted') {
        assert.equal(await readFile(path, 'utf8'), 'TEST-FOREIGN-PROVISIONAL');
      }
    }
  } finally {
    fsPromises.open = originalOpen;
    monitor?.restore();
    syncBuiltinESMExports();
    await subject.close();
    await x.scope.close();
    await x.f.cleanup();
  }
}

for (const lane of runtimeLanes) {
  test(`${lane}: coercible role and mode requests return typed refusals without reservations or children`, async () => {
    const x: PreparedRuntime = await prepareRuntime(lane);
    const monitor: SpawnMonitor = monitorSpawns();
    let hooks = 0;
    try {
      const before = await readdir(x.attemptInput.externalRoot);
      const roles: readonly CoercionValue[] = [
        { toString(): string { hooks++; return 'source'; } },
        { [Symbol.toPrimitive](): never { hooks++; throw new Error('role coercion'); } }
      ];
      for (const role of roles) {
        const request: ManagedAttemptInput = { ...x.attemptInput };
        const descriptor: CoercionDescriptor = {
          value: role, enumerable: true, configurable: true, writable: true
        };
        Object.defineProperty(request, 'role', descriptor);
        const result: AttemptAcquisition = await x.scope.acquireAttempt(request);
        assert.ok(result.outcome === 'refused', JSON.stringify(result));
        assert.equal(result.code, 'invalid-selection');
        assert.equal(result.debt, null);
        assert.deepEqual(await readdir(x.attemptInput.externalRoot), before);
      }
      const acquired: AttemptAcquisition = await x.scope.acquireAttempt(x.attemptInput);
      assert.ok(acquired.outcome === 'acquired', JSON.stringify(acquired));
      const root = x.scope.ownedInstallationRoot();
      assert.ok(root);
      const modes: readonly CoercionValue[] = [
        { toString(): string { hooks++; return 'prepare'; } },
        { [Symbol.toPrimitive](): never { hooks++; throw new Error('mode coercion'); } }
      ];
      for (const mode of modes) {
        const request: ManagedPnpmInstallInput = {
          root,
          runtime: x.attemptInput.runtime,
          mode: 'prepare',
          expectedManifestDigest: '2'.repeat(64),
          expectedWorkspaceDigest: '3'.repeat(64),
          expectedLockDigest: null,
          signal: x.attemptInput.signal
        };
        const descriptor: CoercionDescriptor = {
          value: mode, enumerable: true, configurable: true, writable: true
        };
        Object.defineProperty(request, 'mode', descriptor);
        const result: ManagedPnpmInstallResult = await x.scope.install(request);
        assert.ok(result.outcome === 'refused', JSON.stringify(result));
        assert.equal(result.code, 'invalid-selection');
        assert.equal(result.facts.spawned, false);
        assert.equal(result.debt, null);
      }
      assert.equal(hooks, 0);
      assert.equal(monitor.count(), 0);
      assert.deepEqual(await acquired.attempt.close(), { outcome: 'closed' });
    } finally {
      monitor.restore();
      await x.scope.close();
      await x.f.cleanup();
    }
  });

  for (const disposal of uncertainDisposals) {
    test(`${lane}: provisional reservation disposal ${disposal} reports its actual settlement`, async () => {
      // Retain clean settlement as a control within the modification regression.
      if (disposal === 'modified') {
        await assertProvisionalDisposal(lane, 'unchanged');
      }
      await assertProvisionalDisposal(lane, disposal);
    });
  }

  test(`${lane}: independent contender shares exclusion after the physical consumer is renamed`, async () => {
    const x: InstallationFixture = await setupInstallation(lane, 'physical consumer rename');
    const consumer = x.attemptInput.consumerRoot;
    const alternate = join(x.f.root, 'TEST-consumer-renamed');
    let renamed = false;
    try {
      const identity = await stat(consumer, { bigint: true });
      const record = await readFile(x.acquisition.attempt.evidencePath);
      await rename(consumer, alternate);
      renamed = true;
      const same = await stat(alternate, { bigint: true });
      assert.equal(same.dev, identity.dev);
      assert.equal(same.ino, identity.ino);
      assert.deepEqual(peerAcquisition(x, alternate), {
        outcome: 'refused', code: 'liveness-uncertain'
      });
      assert.deepEqual(await readFile(x.acquisition.attempt.evidencePath), record);
      await rename(alternate, consumer);
      renamed = false;
      assert.deepEqual(await x.acquisition.attempt.close(), { outcome: 'closed' });
    } finally {
      if (renamed) {
        await rename(alternate, consumer);
      }
      await x.scope.close();
      await x.f.cleanup();
    }
  });

  test(`${lane}: external direct tarball symlink refuses before any install child`, async () => {
    const x: InstallationFixture = await setupInstallation(
      lane, `${lane}: external direct tarball symlink refuses before any install child`
    );
    try {
      await pack(x.f.root, 'external', {
        name: 'external', version: '1.0.0', main: 'index.js'
      });
      const external = join(x.f.root, 'external.tgz');
      const before = await readFile(external);
      await fsPromises.symlink(external, join(x.root, 'external.tgz'));
      const manifest = JSON.stringify({
        name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { external: 'file:./external.tgz' }
      }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const result: ManagedPnpmInstallResult = await runInstall(x, {
        ...x.input, expectedManifestDigest: sha(manifest)
      });
      assert.ok(result.outcome === 'refused', JSON.stringify(result));
      assert.equal(result.code, 'invalid-selection');
      assert.equal(result.facts.spawned, false);
      assert.equal(result.debt, null);
      assert.deepEqual(await readFile(external), before);
      for (const name of ['pnpm-lock.yaml', 'node_modules', '.managed-pnpm-store']) {
        await assert.rejects(stat(join(x.root, name)), { code: 'ENOENT' });
      }
    } finally {
      await x.scope.close();
      await x.f.cleanup();
    }
  });

  test(`${lane}: registry transitive in a local tarball refuses before any install child`, async () => {
    const x: InstallationFixture = await setupInstallation(
      lane, `${lane}: registry transitive in a local tarball refuses before any install child`
    );
    try {
      const dependency = await pack(x.root, 'registry-parent', {
        name: 'registry-parent', version: '1.0.0', main: 'index.js',
        dependencies: { 'unsupported-registry-transitive': '1.0.0' }
      });
      const tarball = join(x.root, 'registry-parent.tgz');
      const before = await readFile(tarball);
      const manifest = JSON.stringify({
        name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { 'registry-parent': dependency }
      }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const result: ManagedPnpmInstallResult = await runInstall(x, {
        ...x.input, expectedManifestDigest: sha(manifest)
      });
      assert.ok(result.outcome === 'refused', JSON.stringify(result));
      assert.equal(result.code, 'invalid-selection');
      assert.equal(result.facts.spawned, false);
      assert.equal(result.debt, null);
      assert.deepEqual(await readFile(tarball), before);
      for (const name of ['pnpm-lock.yaml', 'node_modules', '.managed-pnpm-store']) {
        await assert.rejects(stat(join(x.root, name)), { code: 'ENOENT' });
      }
    } finally {
      await x.scope.close();
      await x.f.cleanup();
    }
  });

  test(`${lane}: compressed tarball exceeding the expansion bound refuses before any install child`, async () => {
    const x: InstallationFixture = await setupInstallation(
      lane, `${lane}: compressed tarball exceeding the expansion bound refuses before any install child`
    );
    try {
      const dependency = await pack(x.root, 'expanded-limit', {
        name: 'expanded-limit', version: '1.0.0'
      }, Buffer.alloc(64 * 1024 * 1024 + 1));
      assert.ok((await stat(join(x.root, 'expanded-limit.tgz'))).size < 1024 * 1024);
      const manifest = JSON.stringify({
        name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { 'expanded-limit': dependency }
      }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const result: ManagedPnpmInstallResult = await runInstall(x, {
        ...x.input, expectedManifestDigest: sha(manifest)
      });
      assert.ok(result.outcome === 'refused', JSON.stringify(result));
      assert.equal(result.code, 'invalid-selection');
      assert.equal(result.facts.spawned, false);
      assert.equal(result.debt, null);
      await assert.rejects(stat(join(x.root, 'pnpm-lock.yaml')), { code: 'ENOENT' });
      await assert.rejects(stat(join(x.root, '.managed-pnpm-store')), { code: 'ENOENT' });
    } finally {
      await x.scope.close();
      await x.f.cleanup();
    }
  });
}
