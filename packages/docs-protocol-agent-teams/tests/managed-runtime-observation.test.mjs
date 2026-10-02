import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { chmod, copyFile, link, mkdir, readFile, readdir, rename, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import childProcess, { spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { fixture, negativePackageSelection } from './managed-runtime-fixtures.mjs';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';

// A bound synthetic package tests refusal boundaries; it is never actual pnpm qualification.
async function negativeObservationFixture() {
  const f = await fixture('node24');
  const manifest = `${f.packageRoot}/package.json`;
  const parsed = JSON.parse(await readFile(manifest, 'utf8'));
  parsed.version = '11.20.0';
  await writeFile(manifest, JSON.stringify(parsed));
  await writeFile(`${f.packageRoot}/bin/pnpm.mjs`, 'process.stdout.write("11.20.0\\n")');
  const negative = await negativePackageSelection(f);
  const manifestSha = createHash('sha256').update(await readFile(manifest)).digest('hex');
  return { ...f, selection: { ...negative, pnpmPackage: { ...negative.pnpmPackage,
    expectedManifestSha256: manifestSha } } };
}

for (const lane of ['node24', 'node26']) {
  test(`actual ${lane} plus actual pnpm observes selected tuple and reaps`, { timeout: 120_000 }, async () => {
    const f = await fixture(lane);
    const signal = new AbortController().signal;
    const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    try {
      const admitted = await scope.admit();
      assert.equal(admitted.outcome, 'admitted');
      const forged = await scope.observe({ runtime: { kind: 'managed-runtime-handle' }, expected: f.expected, signal });
      assert.equal(forged.code, 'invalid-selection');
      assert.equal(forged.facts.spawned, false);
      let requestGetterCalled = false;
      const accessorRequest = await scope.observe({ expected: f.expected, signal,
        get runtime() { requestGetterCalled = true; throw new Error('request accessor'); } });
      assert.equal(accessorRequest.code, 'invalid-selection');
      assert.equal(requestGetterCalled, false);
      const marker = `${f.root}/ambient-marker`;
      await writeFile(`${f.root}/poison.cjs`, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
      const prior = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS,
        npm_config_engine_strict: process.env.npm_config_engine_strict };
      process.env.PATH = f.root;
      process.env.NODE_OPTIONS = `--require=${f.root}/poison.cjs`;
      process.env.npm_config_engine_strict = 'false';
      let result;
      try { result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal }); }
      finally {
        for (const [key, value] of Object.entries(prior)) {
          if (value === undefined) {delete process.env[key];} else {process.env[key] = value;}
        }
      }
      await assert.rejects(stat(marker), { code: 'ENOENT' });
      assert.equal(result.outcome, 'observed', JSON.stringify(result));
      assert.deepEqual(result.observation.tuple, f.expected);
      assert.equal(result.observation.node.sha256, f.trusted.nodeSha);
      assert.equal(result.observation.pnpm.packageTreeDigest, f.trusted.treeSha);
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
      assert.equal(result.facts.streams, 'closed');
      const direct = spawnSync(f.node, [`${f.packageRoot}/bin/pnpm.mjs`, '--version'],
        { cwd: f.root, encoding: 'utf8', timeout: 30_000, env: { CI: 'true', LANG: 'C', HOME: f.root } });
      assert.equal(direct.status, 0);
      assert.equal(direct.stdout, `${f.expected.pnpmVersion}\n`);
      assert.deepEqual(await Promise.all([scope.close(), scope.close()]),
        [{ outcome: 'closed' }, { outcome: 'closed' }]);
      const afterClose = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
      assert.equal(afterClose.code, 'invalid-selection');
    } finally { await f.cleanup(); }
  });
}

for (const lane of ['node24', 'node26']) {
  test(`${lane}: simultaneous observations reserve one operation before directory preflight`, { timeout: 120_000 }, async () => {
    const f = await fixture(lane);
    const signal = new AbortController().signal;
    const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    try {
      const admitted = await scope.admit();
      assert.equal(admitted.outcome, 'admitted');
      const request = { runtime: admitted.runtime, expected: f.expected, signal };
      const [first, second] = await Promise.all([scope.observe(request), scope.observe(request)]);
      assert.equal(first.outcome, 'observed', JSON.stringify(first));
      assert.equal(second.code, 'invalid-selection', JSON.stringify(second));
      assert.equal(second.facts.spawned, false);
      assert.equal((await scope.close()).outcome, 'closed');
    } finally {await scope.close(); await f.cleanup();}
  });

  test(`${lane}: close waits for a child held at the private handshake`, { timeout: 120_000 }, async () => {
    const f = await fixture(lane);
    const signal = new AbortController().signal;
    const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    const originalRealpath = fsPromises.realpath;
    const originalSpawn = childProcess.spawn;
    let release;
    let reached;
    const atHandshake = new Promise(resolve => {reached = resolve;});
    const barrier = new Promise(resolve => {release = resolve;});
    const children = [];
    let observation;
    try {
      const admitted = await scope.admit();
      assert.equal(admitted.outcome, 'admitted');
      const owned = `${f.root}/${(await readdir(f.root)).find(name => name.startsWith('managed-runtime-'))}`;
      fsPromises.realpath = async (...args) => {
        if (typeof args[0] === 'string' && /^\/proc\/\d+\/exe$/.test(args[0])) {
          reached();
          await barrier;
        }
        return originalRealpath(...args);
      };
      childProcess.spawn = (...args) => {
        const child = originalSpawn(...args);
        children.push(child);
        return child;
      };
      syncBuiltinESMExports();
      observation = scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
      await atHandshake;
      assert.equal(children.length, 1);
      assert.equal(children[0].exitCode, null);
      assert.equal(children[0].signalCode, null);
      let closed = false;
      const closing = scope.close().then(result => {closed = true; return result;});
      await new Promise(resolve => {setTimeout(resolve, 25);});
      assert.equal(closed, false);
      assert.equal((await stat(owned)).isDirectory(), true);
      release();
      const result = await observation;
      assert.equal(result.code, 'cancelled', JSON.stringify(result));
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
      assert.equal((await closing).outcome, 'closed');
    } finally {
      release();
      if (observation) {await observation;}
      fsPromises.realpath = originalRealpath;
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      await scope.close();
      await f.cleanup();
    }
  });
}

test('changed package bundle and false tuple refuse without success', { timeout: 120_000 }, async () => {
  const f = await fixture('node24');
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    assert.equal((await scope.observe({ runtime: admitted.runtime,
      expected: { ...f.expected, architecture: 'arm64' }, signal })).code, 'runtime-mismatch');
    assert.equal((await scope.observe({ runtime: admitted.runtime,
      expected: { ...f.expected, nodeVersion: '26.10.0' }, signal })).code, 'runtime-mismatch');
    assert.equal((await scope.observe({ runtime: admitted.runtime,
      expected: { ...f.expected, pnpmVersion: '11.19.0' }, signal })).code, 'runtime-mismatch');
    await writeFile(`${f.packageRoot}/dist/pnpm.mjs`, 'process.stdout.write("11.20.0\\n")');
    const changed = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(changed.code, 'identity-changed');
    assert.equal(changed.facts.spawned, false);
    assert.deepEqual(await scope.close(), { outcome: 'closed' });
  } finally { await f.cleanup(); }
});

test('Corepack, foreign handles, and pre-aborted requests refuse before spawn', { timeout: 120_000 }, async () => {
  const f = await fixture('node26');
  const signal = new AbortController().signal;
  try {
    const corepack = createNodeManagedRuntimeScope({ privateRoot: f.root,
      selection: { ...f.selection, launcher: 'corepack' }, signal });
    assert.equal((await corepack.admit()).code, 'unsupported-launcher');
    const otherPlatform = createNodeManagedRuntimeScope({ privateRoot: f.root,
      selection: { ...f.selection, expected: { ...f.expected, platform: 'macos' } }, signal });
    assert.equal((await otherPlatform.admit()).code, 'unsupported-platform');
    let accessorCalled = false;
    const accessor = createNodeManagedRuntimeScope({ privateRoot: f.root, signal,
      get selection() { accessorCalled = true; throw new Error('accessor must not run'); } });
    assert.equal((await accessor.admit()).code, 'invalid-selection');
    assert.equal(accessorCalled, false);
    const a = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    const b = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    const admitted = await a.admit();
    assert.equal(admitted.outcome, 'admitted');
    const other = await b.admit();
    assert.equal(other.outcome, 'admitted');
    assert.equal((await b.observe({ runtime: admitted.runtime, expected: f.expected, signal })).facts.spawned, false);
    assert.equal((await a.observe({ runtime: JSON.parse(JSON.stringify(admitted.runtime)),
      expected: f.expected, signal })).facts.spawned, false);
    const controller = new AbortController(); controller.abort();
    const refused = await a.observe({ runtime: admitted.runtime, expected: f.expected, signal: controller.signal });
    assert.equal(refused.code, 'cancelled'); assert.equal(refused.facts.spawned, false);
    assert.equal((await a.close()).outcome, 'closed');
    assert.equal((await b.close()).outcome, 'closed');
  } finally { await f.cleanup(); }
});

test('a selected executable alias and changed executable bytes refuse before spawn', { timeout: 120_000 }, async () => {
  const f = await fixture('node24');
  const signal = new AbortController().signal;
  try {
    const alias = `${f.root}/node-link`;
    await symlink(f.node, alias);
    const aliasScope = createNodeManagedRuntimeScope({ privateRoot: f.root,
      selection: { ...f.selection, selectedNode: { ...f.selection.selectedNode, path: alias } }, signal });
    assert.equal((await aliasScope.admit()).code, 'identity-changed');
    const packageAlias = `${f.root}/pnpm-link`;
    await symlink(f.packageRoot, packageAlias);
    const packageScope = createNodeManagedRuntimeScope({ privateRoot: f.root,
      selection: { ...f.selection, pnpmPackage: { ...f.selection.pnpmPackage, root: packageAlias } }, signal });
    assert.equal((await packageScope.admit()).code, 'identity-changed');
    const changed = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    await writeFile(f.node, 'not the selected node');
    assert.equal((await changed.admit()).code, 'identity-changed');
    assert.equal((await changed.close()).outcome, 'closed');
  } finally { await f.cleanup(); }
});

test('unsafe copied runtime inventory refuses admission', { timeout: 120_000 }, async t => {
  const cases = [
    ['same-version bin shim', async f => writeFile(`${f.packageRoot}/bin/pnpm.mjs`,
      'process.stdout.write("11.20.0\\n")')],
    ['hardlinked Node copy', async f => {
      const other = `${f.root}/other-node`;
      await copyFile(f.node, other);
      await unlink(f.node);
      await link(other, f.node);
    }],
    ['oversized Node copy', async f => truncate(f.node, 256 * 1024 * 1024 + 1)],
    ['missing Node copy', async f => unlink(f.node)],
    ['package tree symlink', async f => symlink(f.node, `${f.packageRoot}/unexpected-link`)]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const f = await fixture('node24');
      try {
        await mutate(f);
        const scope = createNodeManagedRuntimeScope({ privateRoot: f.root,
          selection: f.selection, signal: new AbortController().signal });
        assert.equal((await scope.admit()).code, 'identity-changed');
        assert.equal((await scope.close()).outcome, 'closed');
      } finally { await f.cleanup(); }
    });
  }
});

test('same-byte package replacement after admission still changes physical identity', { timeout: 120_000 }, async () => {
  const f = await fixture('node24');
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    const bundle = `${f.packageRoot}/dist/pnpm.mjs`;
    await copyFile(bundle, `${bundle}.replacement`);
    await rename(`${bundle}.replacement`, bundle);
    const result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(result.code, 'identity-changed');
    assert.equal(result.facts.spawned, false);
    assert.equal((await scope.close()).outcome, 'closed');
  } finally { await f.cleanup(); }
});

test('returned nested evidence cannot retarget the live executable handle', { timeout: 120_000 }, async () => {
  const f = await negativeObservationFixture();
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    const first = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(first.outcome, 'observed', JSON.stringify(first));
    await copyFile(f.node, `${f.node}.replacement`);
    await rename(`${f.node}.replacement`, f.node);
    const replacement = await stat(f.node, { bigint: true });
    Object.assign(first.observation.node, { inode: replacement.ino.toString(),
      device: replacement.dev.toString(), birthtimeNs: replacement.birthtimeNs.toString(),
      ctimeNs: replacement.ctimeNs.toString(), mtimeNs: replacement.mtimeNs.toString() });
    Object.assign(first.observation.tuple, { nodeVersion: '26.10.0' });
    Object.assign(first.observation.pnpm.manifest, { sha256: '0'.repeat(64) });
    const result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(result.code, 'identity-changed', JSON.stringify(result));
    assert.equal(result.facts.spawned, false);
    assert.equal((await scope.close()).outcome, 'closed');
  } finally { await f.cleanup(); }
});

for (const retarget of ['directory', 'parent']) {
  test(`${retarget} substitution retains cleanup debt and never deletes replacement`, { timeout: 120_000 }, async () => {
    const f = await negativeObservationFixture();
    const signal = new AbortController().signal;
    const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
    try {
      assert.equal((await scope.admit()).outcome, 'admitted');
      const name = (await readdir(f.root)).find(value => value.startsWith('managed-runtime-'));
      const owned = `${f.root}/${name}`;
      const original = retarget === 'directory' ? `${owned}.original` : `${f.root}.original`;
      const substituted = retarget === 'directory' ? owned : f.root;
      await rename(retarget === 'directory' ? owned : f.root, original);
      await mkdir(substituted);
      if (retarget === 'parent') {await mkdir(owned);}
      await writeFile(`${owned}/FOREIGN-SENTINEL`, 'foreign fixture data');
      const closed = await scope.close();
      assert.equal(closed.outcome, 'debt');
      assert.equal(closed.debt.code, 'cleanup-failed');
      assert.equal(closed.debt.attemptId, owned);
      assert.equal((await stat(`${owned}/FOREIGN-SENTINEL`)).isFile(), true);
      assert.deepEqual(await scope.close(), closed);
    } finally {
      if (retarget === 'parent') {
        await f.cleanup();
        try {await rename(`${f.root}.original`, f.root);}
        catch (error) {assert.equal(error.code, 'ENOENT');}
      }
      await f.cleanup();
    }
  });
}

for (const cancelledBy of ['request', 'scope']) {
  test(`${cancelledBy} abort during final image verification cannot return success`, { timeout: 120_000 }, async () => {
    const f = await negativeObservationFixture();
    const request = new AbortController();
    const owner = new AbortController();
    const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal: owner.signal });
    const originalOpen = fsPromises.open;
    let nodeOpens = 0;
    try {
      const admitted = await scope.admit();
      assert.equal(admitted.outcome, 'admitted');
      fsPromises.open = async (...args) => {
        if (args[0] === f.node && ++nodeOpens === 3) {
          (cancelledBy === 'request' ? request : owner).abort();
        }
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal: request.signal });
      assert.equal(nodeOpens, 3);
      assert.equal(result.code, 'cancelled', JSON.stringify(result));
      assert.equal(result.facts.cancelled, true);
      assert.equal(result.facts.directChild, 'reaped');
      assert.equal(result.facts.group, 'empty-observed');
      assert.equal(result.debt, null);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
      await scope.close();
      await f.cleanup();
    }
  });
}

test('malformed stderr cannot produce an observation receipt', { timeout: 120_000 }, async () => {
  const f = await negativeObservationFixture();
  await writeFile(`${f.packageRoot}/bin/pnpm.mjs`,
    'process.stderr.write(Buffer.from([255])); process.stdout.write("11.20.0\\n")');
  const rebound = await negativePackageSelection(f);
  const selection = { ...f.selection, pnpmPackage: { ...rebound.pnpmPackage,
    expectedManifestSha256: f.selection.pnpmPackage.expectedManifestSha256 } };
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    const result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'invalid-output', JSON.stringify(result));
    assert.equal(result.facts.group, 'empty-observed');
    assert.equal(result.debt, null);
    assert.equal((await scope.close()).outcome, 'closed');
  } finally {await f.cleanup();}
});

test('aborted admission retains debt when its acquired directory is substituted', { timeout: 120_000 }, async () => {
  const f = await negativeObservationFixture();
  const controller = new AbortController();
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root,
    selection: f.selection, signal: controller.signal });
  const originalLstat = fsPromises.lstat;
  let substituted = null;
  try {
    fsPromises.lstat = async (...args) => {
      const info = await originalLstat(...args);
      if (!substituted && typeof args[0] === 'string' &&
          args[0].startsWith(`${f.root}/managed-runtime-`)) {
        substituted = args[0];
        await rename(substituted, `${substituted}.original`);
        await mkdir(substituted);
        await writeFile(`${substituted}/FOREIGN-SENTINEL`, 'foreign fixture data');
        controller.abort();
      }
      return info;
    };
    syncBuiltinESMExports();
    const result = await scope.admit();
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'cleanup-failed', JSON.stringify(result));
    assert.equal(result.debt.attemptId, substituted);
    assert.equal((await stat(`${substituted}/FOREIGN-SENTINEL`)).isFile(), true);
    assert.equal((await scope.close()).outcome, 'debt');
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('post-launch package swap refuses even when a synthetic child prints the expected version', {
  timeout: 120_000
}, async () => {
  const f = await fixture('node24');
  const entry = `${f.packageRoot}/bin/pnpm.mjs`;
  await writeFile(entry, `import { watch, writeFileSync } from 'node:fs';
    const watcher = watch('.', (_event, name) => {
      if (name === 'release') {watcher.close(); process.stdout.write('11.20.0\\n');}
    });
    writeFileSync('ready', '1');`);
  const selection = await negativePackageSelection(f);
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection, signal });
  let watcher;
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    const owned = `${f.root}/${(await readdir(f.root)).find(name => name.startsWith('managed-runtime-'))}`;
    const ready = new Promise(resolve => {
      watcher = watch(owned, (_event, name) => {if (name === 'ready') {resolve();}});
    });
    const observing = scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    const first = await Promise.race([
      ready.then(() => ({ kind: 'ready' })),
      observing.then(result => ({ kind: 'settled', result }))
    ]);
    assert.equal(first.kind, 'ready', JSON.stringify(first));
    await writeFile(`${f.packageRoot}/dist/pnpm.mjs`, 'test-owned changed bundle');
    await writeFile(`${owned}/release`, '1');
    const result = await observing;
    assert.equal(result.code, 'identity-changed', JSON.stringify({ code: result.code, facts: result.facts }));
    assert.equal(result.facts.directChild, 'reaped');
    assert.equal(result.facts.group, 'empty-observed');
    assert.equal((await scope.close()).outcome, 'closed');
  } finally { watcher?.close(); await scope.close(); await f.cleanup(); }
});

test('synthetic wrong pnpm stdout cannot override the selected tuple', { timeout: 120_000 }, async () => {
  const f = await fixture('node24');
  await writeFile(`${f.packageRoot}/bin/pnpm.mjs`, 'process.stdout.write("11.19.0\\n")');
  const selection = await negativePackageSelection(f);
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    const result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(result.code, 'runtime-mismatch');
    assert.equal(result.facts.group, 'empty-observed');
    assert.equal((await scope.close()).outcome, 'closed');
  } finally { await f.cleanup(); }
});

test('closing during observation cancels before success and releases the owned root', { timeout: 120_000 }, async () => {
  const f = await fixture('node24');
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, 'admitted');
    const running = scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    const closing = scope.close();
    const result = await running;
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'cancelled');
    assert.equal((await closing).outcome, 'closed');
  } finally { await f.cleanup(); }
});

test('unprivileged denied cleanup retains owned-root debt', {
  skip: process.getuid?.() === 0 ? 'requires an unprivileged test identity' : false,
  timeout: 120_000
}, async () => {
  process.umask(0o022);
  const f = await fixture('node24');
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection, signal });
  let owned;
  try {
    assert.equal((await scope.admit()).outcome, 'admitted');
    owned = `${f.root}/${(await readdir(f.root)).find(name => name.startsWith('managed-runtime-'))}`;
    await writeFile(`${owned}/retained`, 'test-owned');
    await chmod(owned, 0o000);
    await assert.rejects(writeFile(`${owned}/denied`, 'x'), { code: 'EACCES' });
    const closed = await scope.close();
    assert.equal(closed.outcome, 'debt');
    assert.equal(closed.debt.code, 'cleanup-failed');
    assert.equal(closed.debt.attemptId, owned);
  } finally {
    if (owned) {await chmod(owned, 0o700);}
    await f.cleanup();
  }
});
