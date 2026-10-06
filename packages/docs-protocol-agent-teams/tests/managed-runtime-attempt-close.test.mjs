import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import fsPromises, { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './managed-runtime-fixtures.mjs';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';

const sha = value => createHash('sha256').update(value).digest('hex');
async function setup(lane) {
  const f = await fixture(lane);
  const external = join(f.root, 'TEST-attempt-records');
  const consumer = join(f.root, 'TEST-consumer');
  await Promise.all([mkdir(external), mkdir(consumer)]);
  const controller = new AbortController();
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection,
    signal: controller.signal });
  const admission = await scope.admit();
  assert.equal(admission.outcome, 'admitted');
  const acquisition = await scope.acquireAttempt({ externalRoot: external, consumerRoot: consumer,
    controllerBuildDigest: '1'.repeat(64), role: 'source', runtime: admission.runtime,
    signal: controller.signal });
  assert.equal(acquisition.outcome, 'acquired');
  const root = acquisition.attempt.ownedRoot;
  const manifest = JSON.stringify({ name: 'test-close-race', version: '1.0.0', private: true,
    packageManager: 'pnpm@11.20.0', dependencies: {} }) + '\n';
  const workspace = 'packages: []\n';
  await writeFile(join(root, 'package.json'), manifest);
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
  const input = { root: scope.ownedInstallationRoot(), runtime: admission.runtime,
    mode: 'prepare', expectedManifestDigest: sha(manifest), expectedWorkspaceDigest: sha(workspace),
    expectedLockDigest: null, signal: controller.signal };
  return { f, scope, acquisition, root, input };
}

const deferred = () => {
  let finish;
  const promise = new Promise(resolve => {finish = resolve;});
  return { promise, resolve: finish };
};
const live = child => child && child.exitCode === null && child.signalCode === null;
function holdCloseAtExternalRoot(x) {
  const original = fsPromises.realpath;
  const entered = deferred();
  const release = deferred();
  let held = false;
  fsPromises.realpath = async (...args) => {
    if (args[0] === join(x.f.root, 'TEST-attempt-records') && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  return { entered: entered.promise, release: release.resolve, restore: () => {
    release.resolve(); fsPromises.realpath = original; syncBuiltinESMExports();
  } };
}
function holdSelectedChild(x) {
  const originalOpen = fsPromises.open;
  const originalSpawn = childProcess.spawn;
  const entered = deferred();
  const release = deferred();
  let opens = 0;
  let child = null;
  fsPromises.open = async (...args) => {
    if (args[0] === x.f.node && ++opens === 2) {
      entered.resolve();
      await release.promise;
    }
    return originalOpen(...args);
  };
  childProcess.spawn = (...args) => {
    const spawned = originalSpawn(...args);
    if (args[0] === x.f.node) {child = spawned;}
    return spawned;
  };
  syncBuiltinESMExports();
  return { entered: entered.promise, release: release.resolve, child: () => child,
    restore: () => {release.resolve(); fsPromises.open = originalOpen;
      childProcess.spawn = originalSpawn; syncBuiltinESMExports();} };
}
async function peerAcquisition(x) {
  const script = join(x.f.root, 'TEST-second-peer.mjs');
  const module = new URL('../dist/consumer-integration/adapters/node-managed-runtime.js', import.meta.url).href;
  await writeFile(script, `import {createNodeManagedRuntimeScope} from ${JSON.stringify(module)};
    const signal = new AbortController().signal;
    const scope = createNodeManagedRuntimeScope({privateRoot: process.env.TEST_ROOT,
      selection: JSON.parse(process.env.TEST_SELECTION), signal});
    const admission = await scope.admit();
    if (admission.outcome !== 'admitted') process.exit(2);
    const result = await scope.acquireAttempt({externalRoot: process.env.TEST_EXTERNAL,
      consumerRoot: process.env.TEST_CONSUMER, controllerBuildDigest: '1'.repeat(64),
      role: 'source', runtime: admission.runtime, signal});
    console.log(JSON.stringify({outcome: result.outcome, code: result.code}));
    await scope.close();`);
  return JSON.parse(execFileSync(x.f.node, [script], { encoding: 'utf8', timeout: 15_000,
    env: { TEST_ROOT: x.f.root, TEST_SELECTION: JSON.stringify(x.f.selection),
      TEST_EXTERNAL: join(x.f.root, 'TEST-attempt-records'),
      TEST_CONSUMER: join(x.f.root, 'TEST-consumer') } }).trim());
}

test('issued attempt close reserves before IO and refuses a later install', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26', 'close-first');
  const barrier = holdCloseAtExternalRoot(x);
  try {
    const close = x.acquisition.attempt.close();
    assert.equal(x.scope.ownedInstallationRoot(), null, 'reservation is synchronous');
    await barrier.entered;
    const install = await x.scope.install(x.input);
    assert.equal(install.outcome, 'refused');
    assert.equal(install.facts.spawned, false);
    assert.equal((await stat(x.root)).isDirectory(), true);
    barrier.release();
    assert.deepEqual(await close, { outcome: 'closed' });
  } finally {barrier.restore(); await x.scope.close(); await x.f.cleanup();}
});

test('issued attempt close waits for the real selected install child to settle', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26', 'install-first');
  const barrier = holdSelectedChild(x);
  let installation;
  try {
    installation = x.scope.install(x.input);
    await barrier.entered;
    assert.equal(live(barrier.child()), true);
    const record = JSON.parse(await readFile(x.acquisition.attempt.evidencePath, 'utf8'));
    assert.equal(record.phase, 'running');
    assert.equal(record.child.pid, barrier.child().pid);
    let settled = false;
    const close = x.acquisition.attempt.close().then(value => {settled = true; return value;});
    await new Promise(resolve => {setTimeout(resolve, 50);});
    assert.equal(settled, false);
    assert.equal((await stat(x.root)).isDirectory(), true);
    barrier.release();
    const result = await installation;
    assert.equal(result.code, 'cancelled', JSON.stringify(result));
    assert.equal(result.facts.directChild, 'reaped');
    assert.equal(result.facts.group, 'empty-observed');
    assert.equal(live(barrier.child()), false);
    assert.deepEqual(await close, { outcome: 'closed' });
  } finally {barrier.restore(); await installation; await x.scope.close(); await x.f.cleanup();}
});

test('repeated and concurrent issued attempt closes share one durable result', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26', 'repeat-close');
  const barrier = holdCloseAtExternalRoot(x);
  try {
    const first = x.acquisition.attempt.close();
    const second = x.acquisition.attempt.close();
    assert.strictEqual(second, first);
    await barrier.entered;
    assert.equal((await peerAcquisition(x)).code, 'liveness-uncertain');
    barrier.release();
    assert.deepEqual(await first, { outcome: 'closed' });
    assert.deepEqual(await x.acquisition.attempt.close(), { outcome: 'closed' });
  } finally {barrier.restore(); await x.scope.close(); await x.f.cleanup();}
});

test('concurrent issued closes retain the same cleanup debt and exclusion', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26', 'repeat-debt');
  try {
    await writeFile(x.acquisition.attempt.evidencePath, 'foreign-record\n');
    const first = x.acquisition.attempt.close();
    assert.strictEqual(x.acquisition.attempt.close(), first);
    const result = await first;
    assert.equal(result.outcome, 'debt');
    assert.deepEqual(await x.acquisition.attempt.close(), result);
    assert.equal(await readFile(x.acquisition.attempt.evidencePath, 'utf8'), 'foreign-record\n');
    assert.equal((await peerAcquisition(x)).code, 'liveness-uncertain');
    assert.deepEqual(await x.scope.close(), result);
  } finally {await x.scope.close(); await x.f.cleanup();}
});

test('directory sync failure after record unlink retains a durable peer exclusion', { timeout: 60_000 }, async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26');
  const originalOpen = fsPromises.open;
  const entered = deferred();
  const releaseSync = deferred();
  let injected = 0;
  try {
    fsPromises.open = async (...args) => {
      const fd = await originalOpen(...args);
      if (args[0] === join(x.f.root, 'TEST-attempt-records')) {
        const originalSync = fd.sync.bind(fd);
        fd.sync = async () => {
          let recordMissing = false;
          try {await stat(x.acquisition.attempt.evidencePath);}
          catch (error) {if (error.code === 'ENOENT') {recordMissing = true;} else {throw error;}}
          if (recordMissing && injected++ === 0) {
            entered.resolve();
            await releaseSync.promise;
            throw Object.assign(new Error('TEST release directory sync EIO'), { code: 'EIO' });
          }
          return originalSync();
        };
      }
      return fd;
    };
    syncBuiltinESMExports();
    const first = x.acquisition.attempt.close();
    assert.strictEqual(x.acquisition.attempt.close(), first);
    await Promise.race([entered.promise, first.then(() => {throw new Error('release missed the injected sync');})]);
    const racingPeer = await peerAcquisition(x);
    releaseSync.resolve();
    assert.deepEqual(racingPeer, { outcome: 'refused', code: 'liveness-uncertain' },
      'a peer cannot enter during the uncertain sync');
    const result = await first;
    assert.equal(result.outcome, 'debt');
    assert.equal(result.debt.code, 'cleanup-failed');
    assert.deepEqual(await x.acquisition.attempt.close(), result);
    assert.equal(injected, 1);
    assert.equal((await stat(result.debt.evidencePath)).isFile(), true);
    assert.equal((await peerAcquisition(x)).code, 'liveness-uncertain');
  } finally {releaseSync.resolve(); fsPromises.open = originalOpen; syncBuiltinESMExports();
    await x.scope.close(); await x.f.cleanup();}
});

test('substituted release barrier retains the attempt record and owned data', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26');
  const ownedData = join(x.root, 'TEST-keep.txt');
  await writeFile(ownedData, 'live-owned-data');
  const originalLink = fsPromises.link;
  try {
    fsPromises.link = async (...args) => {
      await originalLink(...args);
      await fsPromises.unlink(args[1]);
      await writeFile(args[1], 'foreign-sibling');
    };
    syncBuiltinESMExports();
    const result = await x.acquisition.attempt.close();
    assert.equal(result.outcome, 'debt');
    assert.equal(result.debt.code, 'cleanup-failed');
    assert.equal(result.debt.evidencePath, x.acquisition.attempt.evidencePath);
    assert.equal(await readFile(ownedData, 'utf8'), 'live-owned-data');
    assert.equal(await readFile(`${x.acquisition.attempt.evidencePath}.release-debt`, 'utf8'), 'foreign-sibling');
    assert.equal((await peerAcquisition(x)).code, 'liveness-uncertain');
  } finally {fsPromises.link = originalLink; syncBuiltinESMExports();
    await x.scope.close(); await x.f.cleanup();}
});

test('late release sibling replacement remains debt after primary sync', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26');
  const barrier = `${x.acquisition.attempt.evidencePath}.release-debt`;
  const originalOpen = fsPromises.open;
  let syncs = 0;
  try {
    fsPromises.open = async (...args) => {
      const fd = await originalOpen(...args);
      if (args[0] === join(x.f.root, 'TEST-attempt-records')) {
        const originalSync = fd.sync.bind(fd);
        fd.sync = async () => {
          await originalSync();
          if (++syncs === 2) {
            await fsPromises.unlink(barrier);
            await writeFile(barrier, 'TEST-FOREIGN-RECORD');
          }
        };
      }
      return fd;
    };
    syncBuiltinESMExports();
    const first = x.acquisition.attempt.close();
    assert.strictEqual(x.acquisition.attempt.close(), first);
    const result = await first;
    assert.equal(syncs, 2);
    assert.equal(result.outcome, 'debt');
    assert.equal(result.debt.code, 'cleanup-failed');
    assert.equal(result.debt.evidencePath, barrier);
    assert.equal(await readFile(barrier, 'utf8'), 'TEST-FOREIGN-RECORD');
    assert.deepEqual(await x.acquisition.attempt.close(), result);
    assert.deepEqual(await x.scope.close(), result);
    assert.deepEqual(await peerAcquisition(x), { outcome: 'refused', code: 'liveness-uncertain' });
  } finally {fsPromises.open = originalOpen; syncBuiltinESMExports();
    await x.scope.close(); await x.f.cleanup();}
});

test('second peer process cannot acquire while issued close races a real install', async () => {
  const x = await setup(process.versions.node.startsWith('24.') ? 'node24' : 'node26', 'second-peer');
  const closeBarrier = holdCloseAtExternalRoot(x);
  const childBarrier = holdSelectedChild(x);
  let installation, close;
  try {
    close = x.acquisition.attempt.close();
    await closeBarrier.entered;
    installation = x.scope.install(x.input);
    const first = await Promise.race([installation.then(result => ({ kind: 'install', result })),
      childBarrier.entered.then(() => ({ kind: 'child' }))]);
    if (first.kind === 'install') {
      assert.equal(first.result.outcome, 'refused', 'a close reservation forbids a new child');
      assert.equal(first.result.facts.spawned, false);
    } else {
      assert.equal(live(childBarrier.child()), true);
      const record = JSON.parse(await readFile(x.acquisition.attempt.evidencePath, 'utf8'));
      assert.equal(record.phase, 'running');
    }
    if (first.kind === 'child') {
      closeBarrier.release();
      const result = await close;
      assert.equal((await peerAcquisition(x)).code, 'liveness-uncertain',
        'a live selected child must retain the durable peer exclusion');
      assert.equal(live(childBarrier.child()), false, 'close must settle the selected child');
      assert.deepEqual(result, { outcome: 'closed' });
    } else {
      assert.equal((await peerAcquisition(x)).code, 'liveness-uncertain');
      closeBarrier.release();
      assert.deepEqual(await close, { outcome: 'closed' });
      assert.equal(childBarrier.child(), null);
    }
  } finally {closeBarrier.restore(); childBarrier.restore(); await installation; await close;
    await x.scope.close(); await x.f.cleanup();}
});
