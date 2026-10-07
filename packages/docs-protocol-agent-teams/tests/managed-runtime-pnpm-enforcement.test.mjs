import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import fsPromises, { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './managed-runtime-fixtures.mjs';
import { runInstall } from './managed-runtime-corrective-helpers.mts';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function pack(root, name, body, payload = null) {
  const dir = join(root, `TEST-package-${name}`);
  await mkdir(join(dir, 'package'), { recursive: true });
  await writeFile(join(dir, 'package/package.json'), JSON.stringify(body));
  await writeFile(join(dir, 'package/index.js'), 'export default 1;\n');
  if (payload) {await writeFile(join(dir, 'package/payload.bin'), payload);}
  const target = join(root, `${name}.tgz`);
  execFileSync('tar', ['-czf', target, '-C', dir, 'package']);
  return `file:./${name}.tgz`;
}
async function setup(lane, scenario) {
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
  const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
    packageManager: 'pnpm@11.20.0', dependencies: {} }) + '\n';
  const workspace = 'packages: []\n';
  await writeFile(join(root, 'package.json'), manifest);
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
  const input = { root: scope.ownedInstallationRoot(), runtime: admission.runtime,
    mode: 'prepare', expectedManifestDigest: sha(manifest), expectedWorkspaceDigest: sha(workspace),
    expectedLockDigest: null, signal: controller.signal };
  return { f, scope, acquisition, root, input, controller, scenario };
}
async function validInput(x) {
  const dependency = await pack(x.root, 'valid', { name: 'valid', version: '1.0.0', main: 'index.js',
    scripts: { preinstall: `${x.f.node} -e "require('node:fs').writeFileSync('TEST-hook-ran','yes')"` } });
  const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
    packageManager: 'pnpm@11.20.0', dependencies: { valid: dependency } }) + '\n';
  await writeFile(join(x.root, 'package.json'), manifest);
  return { ...x.input, expectedManifestDigest: sha(manifest) };
}

for (const lane of ['node24', 'node26']) {
  test(`${lane}: actual selected pnpm installs and frozen offline replay preserves both lock bytes`, async () => {
    const x = await setup(lane, `${lane}: actual selected pnpm installs and frozen offline replay preserves both lock bytes`);
    try {
      const installInput = await validInput(x);
      const first = await runInstall(x, installInput);
      assert.equal(first.outcome, 'installed', JSON.stringify(first));
      assert.equal(first.runtime.tuple.nodeVersion, x.f.expected.nodeVersion);
      assert.equal(await readFile(join(x.root, 'node_modules/valid/package.json'), 'utf8').then(
        value => JSON.parse(value).scripts.preinstall.includes('TEST-hook-ran')), true);
      await assert.rejects(readFile(join(x.root, 'node_modules/valid/TEST-hook-ran')));
      const installedBefore = sha(await readFile(join(x.root, 'node_modules/valid/package.json')));
      await rm(join(x.root, 'node_modules'), { recursive: true });
      const replay = await runInstall(x, { ...installInput, mode: 'frozen-offline',
        expectedLockDigest: first.lockDigest });
      assert.equal(replay.outcome, 'installed', JSON.stringify(replay));
      assert.equal(replay.lockDigest, first.lockDigest);
      assert.equal(sha(await readFile(join(x.root, 'pnpm-lock.yaml'))), first.lockDigest);
      assert.equal(sha(await readFile(join(x.root, 'node_modules/.pnpm/lock.yaml'))), replay.virtualStoreLockDigest);
      assert.equal(sha(await readFile(join(x.root, 'node_modules/valid/package.json'))), installedBefore);
      await assert.rejects(readFile(join(x.root, 'node_modules/valid/TEST-hook-ran')));
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: required >=99 engine dependency fails in actual strict pnpm`, async () => {
    const x = await setup(lane, `${lane}: required >=99 engine dependency fails in actual strict pnpm`);
    try {
      const dependency = await pack(x.root, 'bad-engine', { name: 'bad-engine', version: '1.0.0',
        engines: { node: '>=99' }, main: 'index.js' });
      const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { 'bad-engine': dependency } }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const result = await runInstall(x, { ...x.input, expectedManifestDigest: sha(manifest) });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.code, 'process-failed', JSON.stringify(result));
      assert.equal(result.facts.exitCode !== 0, true);
      assert.equal(result.debt, null);
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
      assert.equal(result.facts.streams, 'closed');
      assert.match(Buffer.from(result.diagnosticTailBase64, 'base64').toString(), /ERR_PNPM_UNSUPPORTED_ENGINE/);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: incompatible required peer fails in actual strict pnpm with auto-install disabled`, async () => {
    const x = await setup(lane, `${lane}: incompatible required peer fails in actual strict pnpm with auto-install disabled`);
    try {
      const peer = await pack(x.root, 'peer', { name: 'peer', version: '1.0.0', main: 'index.js' });
      const consumer = await pack(x.root, 'peer-consumer', { name: 'peer-consumer', version: '1.0.0',
        peerDependencies: { peer: '^2.0.0' }, main: 'index.js' });
      const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { peer, 'peer-consumer': consumer } }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const result = await runInstall(x, { ...x.input, expectedManifestDigest: sha(manifest) });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.code, 'process-failed', JSON.stringify(result));
      assert.equal(result.facts.exitCode !== 0, true);
      assert.equal(result.debt, null);
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
      assert.equal(result.facts.streams, 'closed');
      assert.match(Buffer.from(result.diagnosticTailBase64, 'base64').toString(), /ERR_PNPM_PEER_DEP_ISSUES/);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: failed peer preparation cannot become an installed frozen retry`, async () => {
    const x = await setup(lane, `${lane}: failed peer preparation cannot become an installed frozen retry`);
    try {
      const peer = await pack(x.root, 'peer', { name: 'peer', version: '1.0.0', main: 'index.js' });
      const consumer = await pack(x.root, 'peer-consumer', { name: 'peer-consumer', version: '1.0.0',
        peerDependencies: { peer: '^2.0.0' }, main: 'index.js' });
      const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { peer, 'peer-consumer': consumer } }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const input = { ...x.input, expectedManifestDigest: sha(manifest) };
      const first = await runInstall(x, input);
      assert.equal(first.code, 'process-failed', JSON.stringify(first));
      assert.match(Buffer.from(first.diagnosticTailBase64, 'base64').toString(), /ERR_PNPM_PEER_DEP_ISSUES/);
      await rm(join(x.root, 'node_modules'), { recursive: true, force: true });
      const digest = sha(await readFile(join(x.root, 'pnpm-lock.yaml')));
      const retry = await runInstall(x, { ...input, mode: 'frozen-offline', expectedLockDigest: digest });
      assert.equal(retry.outcome, 'refused', JSON.stringify(retry));
      assert.equal(retry.code, 'process-failed');
      assert.equal(retry.debt, null);
      assert.equal(retry.facts.directChild, 'reaped');
      assert.equal(retry.facts.group, 'empty-observed');
      assert.equal(retry.facts.streams, 'closed');
      assert.match(Buffer.from(retry.diagnosticTailBase64, 'base64').toString(), /unmet peer peer/);
      assert.equal((await x.scope.close()).outcome, 'closed');
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: install receipt cannot retarget the admitted runtime after same-byte replacement`, async () => {
    const x = await setup(lane, `${lane}: install receipt cannot retarget the admitted runtime after same-byte replacement`);
    try {
      const input = await validInput(x);
      const first = await runInstall(x, input);
      assert.equal(first.outcome, 'installed', JSON.stringify(first));
      await copyFile(x.f.node, `${x.f.node}.replacement`);
      await rename(`${x.f.node}.replacement`, x.f.node);
      const replacement = await stat(x.f.node, { bigint: true });
      Object.assign(first.runtime.node, { inode: String(replacement.ino), device: String(replacement.dev),
        birthtimeNs: String(replacement.birthtimeNs), ctimeNs: String(replacement.ctimeNs),
        mtimeNs: String(replacement.mtimeNs) });
      Object.assign(first.runtime.tuple, { nodeVersion: '0.0.0' });
      Object.assign(first.runtime.pnpm.manifest, { sha256: '0'.repeat(64) });
      Object.assign(first.runtime.pnpm.entry, { sha256: '0'.repeat(64) });
      const observation = await x.scope.observe({ runtime: x.input.runtime, expected: x.f.expected,
        signal: x.controller.signal });
      assert.equal(observation.code, 'identity-changed', JSON.stringify(observation));
      assert.equal(observation.facts.spawned, false);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: request abort during final install verification refuses with clean process facts`, async () => {
    const x = await setup(lane, `${lane}: request abort during final install verification refuses with clean process facts`);
    const originalOpen = fsPromises.open;
    try {
      const input = await validInput(x);
      const abort = new AbortController();
      let opens = 0;
      fsPromises.open = async (...args) => {
        if (args[0] === x.f.node && ++opens === 3) {abort.abort();}
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const result = await runInstall(x, { ...input, signal: abort.signal });
      assert.equal(opens, 3);
      assert.equal(abort.signal.aborted, true);
      assert.equal(result.code, 'cancelled', JSON.stringify(result));
      assert.equal(result.facts.cancelled, true);
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
      assert.equal(result.facts.streams, 'closed');
      assert.equal(result.debt, null);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
      await x.scope.close();
      await x.f.cleanup();
    }
  });

  test(`${lane}: changed root and virtual lock bytes refuse frozen replay before spawn`, async () => {
    const x = await setup(lane, `${lane}: changed root and virtual lock bytes refuse frozen replay before spawn`);
    try {
      const input = await validInput(x);
      const first = await runInstall(x, input);
      assert.equal(first.outcome, 'installed', JSON.stringify(first));
      const virtual = join(x.root, 'node_modules/.pnpm/lock.yaml');
      const original = await readFile(virtual);
      await writeFile(virtual, Buffer.concat([original, Buffer.from('# changed\n')]));
      const mismatch = await runInstall(x, { ...input, mode: 'frozen-offline',
        expectedLockDigest: first.lockDigest });
      assert.equal(mismatch.outcome, 'refused');
      assert.equal(mismatch.code, 'identity-changed');
      assert.equal(mismatch.facts.spawned, false);
      await writeFile(virtual, original);
      const lock = join(x.root, 'pnpm-lock.yaml');
      await writeFile(lock, '# wrong lock\n');
      const rootMismatch = await runInstall(x, { ...input, mode: 'frozen-offline',
        expectedLockDigest: first.lockDigest });
      assert.equal(rootMismatch.outcome, 'refused');
      assert.equal(rootMismatch.facts.spawned, false);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: false strictness project config refuses before spawn`, async () => {
    const x = await setup(lane, `${lane}: false strictness project config refuses before spawn`);
    try {
      const input = await validInput(x);
      await writeFile(join(x.root, '.npmrc'), 'engine-strict=false\nstrict-peer-dependencies=false\n');
      const result = await runInstall(x, input);
      assert.equal(result.outcome, 'refused');
      assert.equal(result.code, 'invalid-selection');
      assert.equal(result.facts.spawned, false);
      await rm(join(x.root, '.npmrc'));
      const switched = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@99.0.0', dependencies: {} }) + '\n';
      await writeFile(join(x.root, 'package.json'), switched);
      const versionSwitch = await runInstall(x, { ...input, expectedManifestDigest: sha(switched) });
      assert.equal(versionSwitch.outcome, 'refused');
      assert.equal(versionSwitch.code, 'invalid-selection');
      assert.equal(versionSwitch.facts.spawned, false);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: pre-existing unowned modules refuse first frozen install`, async () => {
    const x = await setup(lane, `${lane}: pre-existing unowned modules refuse first frozen install`);
    try {
      const input = await validInput(x);
      const lock = 'lockfileVersion: "9.0"\nimporters: {}\npackages: {}\n';
      await mkdir(join(x.root, 'node_modules/.pnpm'), { recursive: true });
      await writeFile(join(x.root, 'pnpm-lock.yaml'), lock);
      await writeFile(join(x.root, 'node_modules/.pnpm/lock.yaml'), lock);
      const result = await runInstall(x, { ...input, mode: 'frozen-offline',
        expectedLockDigest: sha(lock) });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.code, 'invalid-selection');
      assert.equal(result.facts.spawned, false);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: local tarball changed against locked integrity refuses offline replay`, async () => {
    const x = await setup(lane, `${lane}: local tarball changed against locked integrity refuses offline replay`);
    try {
      const input = await validInput(x);
      const first = await runInstall(x, input);
      assert.equal(first.outcome, 'installed', JSON.stringify(first));
      await rm(join(x.root, 'node_modules'), { recursive: true });
      const tarball = join(x.root, 'valid.tgz');
      const bytes = await readFile(tarball);
      await writeFile(tarball, Buffer.concat([bytes, Buffer.from('changed')]));
      const result = await runInstall(x, { ...input, mode: 'frozen-offline',
        expectedLockDigest: first.lockDigest });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.code, 'identity-changed');
      assert.equal(result.facts.spawned, false);
    } finally {await x.scope.close(); await x.f.cleanup();}
  });

  test(`${lane}: abort after durable running phase refuses a real install and reaps its group`, async () => {
    const x = await setup(lane, `${lane}: abort after durable running phase refuses a real install and reaps its group`);
    try {
      const dependency = await pack(x.root, 'large', { name: 'large', version: '1.0.0', main: 'index.js' },
        randomBytes(8 * 1024 * 1024));
      const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
        packageManager: 'pnpm@11.20.0', dependencies: { large: dependency } }) + '\n';
      await writeFile(join(x.root, 'package.json'), manifest);
      const abort = new AbortController();
      const pending = runInstall(x, { ...x.input, expectedManifestDigest: sha(manifest), signal: abort.signal });
      const deadline = Date.now() + 10_000;
      let running = false;
      while (Date.now() < deadline) {
        try {
          const record = JSON.parse(await readFile(x.acquisition.attempt.evidencePath, 'utf8'));
          if (record.phase === 'running') {running = true; break;}
        } catch { /* A partially rewritten record is retried by this independent observer. */ }
        await new Promise(resolve => {setTimeout(resolve, 5);});
      }
      assert.equal(running, true, 'real selected child reached its durable running phase');
      abort.abort();
      const result = await pending;
      assert.equal(result.outcome, 'refused');
      assert.equal(result.code, 'cancelled', JSON.stringify(result));
      assert.equal(result.facts.cancelled, true);
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
    } finally {await x.scope.close(); await x.f.cleanup();}
  });
}

test('scope close aborts a running owned install before releasing its attempt', async () => {
  const x = await setup('node24', 'scope close aborts a running owned install before releasing its attempt');
  try {
    const dependency = await pack(x.root, 'large-close', { name: 'large-close', version: '1.0.0' },
      randomBytes(8 * 1024 * 1024));
    const manifest = JSON.stringify({ name: 'test-managed-install', version: '1.0.0', private: true,
      packageManager: 'pnpm@11.20.0', dependencies: { 'large-close': dependency } }) + '\n';
    await writeFile(join(x.root, 'package.json'), manifest);
    const pending = runInstall(x, { ...x.input, expectedManifestDigest: sha(manifest) });
    const deadline = Date.now() + 10_000;
    let running = false;
    while (Date.now() < deadline) {
      try {
        running = JSON.parse(await readFile(x.acquisition.attempt.evidencePath, 'utf8')).phase === 'running';
        if (running) {break;}
      } catch { /* Observe the next complete record. */ }
      await new Promise(resolve => {setTimeout(resolve, 5);});
    }
    assert.equal(running, true);
    const close = await x.scope.close();
    const result = await pending;
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'cancelled', JSON.stringify(result));
    assert.equal(close.outcome, 'closed', JSON.stringify(close));
  } finally {await x.scope.close(); await x.f.cleanup();}
});
