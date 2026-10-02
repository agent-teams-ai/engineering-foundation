import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fixture } from './managed-runtime-fixtures.mjs';
import { hashRuntimeFile } from '../dist/consumer-integration/adapters/node-managed-runtime-identity.js';
import { runManagedProbe } from '../dist/consumer-integration/adapters/node-managed-runtime-process.js';

async function probeScenario(source, signal = new AbortController().signal) {
  const f = await fixture('node24');
  const bin = join(f.packageRoot, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'pnpm.mjs'), source);
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  try { return await runManagedProbe({ image, expected: f.expected, cwd: f.root,
    kind: 'pnpm-version', signal }); }
  finally { await f.cleanup(); }
}
async function cleanupGrandchild(f, marker) {
  try {
    const pid = Number(await readFile(join(f.root, 'grandchild.pid'), 'utf8'));
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (command.includes(marker)) {process.kill(pid, 'SIGKILL');}
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {throw error;}
  } finally { await f.cleanup(); }
}
async function cleanupEpermChild(f) {
  const pid = Number(await readFile(join(f.root, 'ready'), 'utf8'));
  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  if (!command.includes(f.packageRoot)) {throw new Error('foreign test process');}
  process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 40; i++) {
    try {process.kill(pid, 0); await new Promise(resolve => {setTimeout(resolve, 25);});}
    catch (error) {if (error.code === 'ESRCH') {return true;} throw error;}
  }
  return false;
}

test('combined output flood refuses and reaps the actual child group', { timeout: 60_000 }, async () => {
  const result = await probeScenario('process.stdout.write(Buffer.alloc(1048577, 65));');
  assert.equal(result.code, 'output-limit', JSON.stringify({ code: result.code, facts: result.facts }));
  assert.ok(result.facts.stdoutBytes + result.facts.stderrBytes > 1048576);
  assert.ok(Buffer.from(result.diagnosticTailBase64, 'base64').length <= 4096);
  assert.equal(result.facts.directChild, 'reaped');
  assert.equal(result.facts.group, 'empty-observed');
  assert.equal(result.facts.streams, 'closed');
});

test('stdout and stderr each below the cap still trip their combined byte limit', {
  timeout: 60_000
}, async () => {
  const result = await probeScenario('process.stdout.write(Buffer.alloc(600000, 65)); process.stderr.write(Buffer.alloc(600000, 66));');
  assert.equal(result.code, 'output-limit');
  assert.ok(result.facts.stdoutBytes < 1048576 && result.facts.stderrBytes < 1048576);
  assert.ok(result.facts.stdoutBytes + result.facts.stderrBytes > 1048576);
  assert.ok(Buffer.from(result.diagnosticTailBase64, 'base64').length <= 4096);
});

test('malformed stdout cannot become a version observation', { timeout: 60_000 }, async () => {
  const result = await probeScenario('process.stdout.write(Buffer.from([255, 254, 10]));');
  assert.equal(result.code, 'invalid-output');
  assert.equal(result.facts.directChild, 'reaped');
  assert.equal(result.facts.group, 'empty-observed');
});

for (const [name, stderr] of [
  ['invalid byte', 'Buffer.from([255])'],
  ['incomplete trailing sequence', 'Buffer.from([226, 130])']
]) {
  test(`malformed stderr ${name} refuses after clean reap`, { timeout: 60_000 }, async () => {
    const result = await probeScenario(`process.stderr.write(${stderr}); process.stdout.write("11.20.0\\n");`);
    assert.equal(result.code, 'invalid-output', JSON.stringify(result));
    assert.equal(result.facts.directChild, 'reaped');
    assert.equal(result.facts.group, 'empty-observed');
    assert.equal(result.facts.streams, 'closed');
  });
}

test('valid stderr UTF-8 split across chunks remains valid', { timeout: 60_000 }, async () => {
  const result = await probeScenario('process.stderr.write(Buffer.from([226])); process.stderr.write(Buffer.from([130, 172])); process.stdout.write("11.20.0\\n");');
  assert.equal(result.code, null, JSON.stringify(result));
  assert.equal(result.output, '11.20.0\n');
});

test('nonzero child exit remains a process refusal after clean group reap', { timeout: 60_000 }, async () => {
  const result = await probeScenario('process.stdout.write("11.20.0\\n"); process.exit(7);');
  assert.equal(result.code, 'process-failed');
  assert.equal(result.facts.exitCode, 7);
  assert.equal(result.facts.group, 'empty-observed');
});

test('pre-aborted probe never spawns', { timeout: 60_000 }, async () => {
  const controller = new AbortController(); controller.abort();
  const result = await probeScenario('process.stdout.write("11.20.0\\n");', controller.signal);
  assert.equal(result.code, 'cancelled');
  assert.equal(result.facts.spawned, false);
});

test('failed executable spawn has no acquired child or group debt', { timeout: 60_000 }, async () => {
  const f = await fixture('node24');
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  try {
    await unlink(f.node);
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'pnpm-version', signal: new AbortController().signal });
    assert.equal(result.code, 'spawn-failed');
    assert.equal(result.facts.spawned, false);
    assert.equal(result.facts.group, 'not-started');
  } finally { await f.cleanup(); }
});

test('fixed Node-only probe reports the selected child executable', { timeout: 60_000 }, async () => {
  const f = await fixture('node26');
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  try {
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'node-identity', signal: new AbortController().signal });
    assert.equal(result.code, null, JSON.stringify({ code: result.code, facts: result.facts }));
    assert.deepEqual(result.handshake, f.expected);
    assert.equal(result.output, '');
    assert.equal(result.facts.group, 'empty-observed');
  } finally { await f.cleanup(); }
});

test('abort after child readiness terminates the owned process group', { timeout: 60_000 }, async () => {
  const f = await fixture('node24');
  const controller = new AbortController();
  const bin = join(f.packageRoot, 'bin');
  await writeFile(join(bin, 'pnpm.mjs'),
    'import { writeFileSync } from "node:fs"; writeFileSync("ready", "1"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  const watcher = watch(f.root, (_event, name) => {
    if (name === 'ready') { controller.abort(); }
  });
  try {
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'pnpm-version', signal: controller.signal });
    assert.equal(result.code, 'cancelled', JSON.stringify(result));
    assert.equal(result.facts.cancelled, true);
    assert.equal(result.facts.directChild, 'reaped');
    assert.equal(result.facts.group, 'empty-observed');
  } finally { watcher.close(); await f.cleanup(); }
});

test('abort after output but before group cleanup cannot become success', { timeout: 60_000 }, async () => {
  const f = await fixture('node24');
  const controller = new AbortController();
  await writeFile(join(f.packageRoot, 'bin/pnpm.mjs'), 'process.stdout.write("11.20.0\\n")');
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  let checked = false;
  const syscalls = {
    groupState(pgid) {
      if (!checked) {checked = true; controller.abort();}
      try {process.kill(-pgid, 0); return 'present';}
      catch (error) {return error.code === 'ESRCH' ? 'absent' : 'unknown';}
    },
    signalGroup(pgid, signal) {process.kill(-pgid, signal);}
  };
  try {
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'pnpm-version', signal: controller.signal }, syscalls);
    assert.equal(checked, true);
    assert.equal(result.output, '11.20.0\n');
    assert.equal(result.code, 'cancelled');
    assert.equal(result.facts.cancelled, true);
    assert.equal(result.facts.directChild, 'reaped');
    assert.equal(result.facts.group, 'empty-observed');
  } finally { await f.cleanup(); }
});

test('probe deadline ends a non-exiting child with explicit timed-out facts', { timeout: 45_000 }, async () => {
  const result = await probeScenario('setInterval(() => {}, 1000);');
  assert.equal(result.code, 'deadline');
  assert.equal(result.facts.timedOut, true);
  assert.equal(result.facts.directChild, 'reaped');
  assert.equal(result.facts.group, 'empty-observed');
  assert.equal(result.facts.streams, 'closed');
});

test('EPERM signal mutation retains cancellation and liveness debt', { timeout: 60_000 }, async () => {
  const f = await fixture('node24');
  const controller = new AbortController();
  await writeFile(join(f.packageRoot, 'bin/pnpm.mjs'),
    'import { writeFileSync } from "node:fs"; writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000);');
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  const watcher = watch(f.root, (_event, name) => {if (name === 'ready') {controller.abort();}});
  const syscalls = {
    groupState(pgid) {
      try {process.kill(-pgid, 0); return 'present';}
      catch (error) {return error.code === 'ESRCH' ? 'absent' : 'unknown';}
    },
    signalGroup() {const error = new Error('test-owned EPERM'); error.code = 'EPERM'; throw error;}
  };
  let safeToRemove = false;
  try {
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'pnpm-version', signal: controller.signal }, syscalls);
    assert.equal(result.code, 'cancelled');
    assert.equal(result.facts.cancelled, true);
    assert.equal(result.facts.group, 'unconfirmed');
  } finally {
    watcher.close();
    safeToRemove = await cleanupEpermChild(f);
    if (safeToRemove) {await f.cleanup();}
  }
  assert.equal(safeToRemove, true, 'the external test owner must reap its surviving child');
});

test('leader exit with surviving cooperative grandchild retains group debt', { timeout: 60_000 }, async () => {
  const f = await fixture('node24');
  const marker = `MANAGED_TEST_${process.pid}_${Date.now()}`;
  const source = `import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}],
      { stdio: 'ignore', detached: false });
    child.unref();
    writeFileSync('grandchild.pid', String(child.pid));`;
  await writeFile(join(f.packageRoot, 'bin/pnpm.mjs'), source);
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  try {
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'pnpm-version', signal: new AbortController().signal });
    assert.equal(result.code, 'liveness-uncertain');
    assert.equal(result.facts.group, 'unconfirmed');
    assert.equal(result.facts.directChild, 'reaped');
  } finally { await cleanupGrandchild(f, marker); }
});

test('detached test child is outside the cooperative group and needs external cleanup', {
  timeout: 60_000
}, async () => {
  const f = await fixture('node24');
  const marker = `DETACHED_TEST_${process.pid}_${Date.now()}`;
  await writeFile(join(f.packageRoot, 'bin/pnpm.mjs'), `import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}],
      { stdio: 'ignore', detached: true });
    child.unref(); writeFileSync('grandchild.pid', String(child.pid));
    process.stdout.write('detached fixture\\n');`);
  const image = { nodePath: f.node, rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null, entry: null, treeDigest: 'test-only-negative' };
  try {
    const result = await runManagedProbe({ image, expected: f.expected, cwd: f.root,
      kind: 'pnpm-version', signal: new AbortController().signal });
    assert.equal(result.facts.group, 'empty-observed');
    assert.equal(result.output, 'detached fixture\n');
    const pid = Number(await readFile(join(f.root, 'grandchild.pid'), 'utf8'));
    assert.match(await readFile(`/proc/${pid}/cmdline`, 'utf8'), /DETACHED_TEST_/);
  } finally { await cleanupGrandchild(f, marker); }
});

for (const subject of ['identity', 'fixture']) {
  test(`${subject}: file substitution before open refuses a FIFO without waiting for a writer`, {
    timeout: 15_000
  }, async () => {
    const script = `
      import assert from 'node:assert/strict';
      import fs, { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
      import { spawnSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      import { tmpdir } from 'node:os';
      import { hashRuntimeFile } from ${JSON.stringify(new URL('../dist/consumer-integration/adapters/node-managed-runtime-identity.js', import.meta.url).href)};
      import { negativePackageSelection } from ${JSON.stringify(new URL('./managed-runtime-fixtures.mjs', import.meta.url).href)};
      const root = await mkdtemp(join(tmpdir(), 'TEST-runtime-fifo-'));
      const target = join(root, 'leaf');
      await mkdir(join(root, 'bin'));
      await writeFile(join(root, 'bin/pnpm.mjs'), 'negative-only entry');
      await writeFile(target, 'regular file at discovery');
      let substituted = false;
      let fifoCreated = false;
      async function substitute(path) {
        if (path !== target || substituted) {return;}
        substituted = true;
        await unlink(target);
        const result = spawnSync('mkfifo', [target]);
        assert.equal(result.status, 0);
        fifoCreated = true;
      }
      for (const method of ['open', 'readFile']) {
        const original = fs[method];
        fs[method] = async (...args) => {await substitute(args[0]); return original(...args);};
      }
      syncBuiltinESMExports();
      try {
        const operation = ${JSON.stringify(subject)} === 'identity'
          ? hashRuntimeFile(target, 1024, false)
          : negativePackageSelection({ packageRoot: root, selection: { pnpmPackage: {} } });
        await assert.rejects(operation);
        assert.equal(substituted, true);
        assert.equal(fifoCreated, true);
        assert.equal((await fs.lstat(target)).isFIFO(), true);
      } finally {await rm(root, { recursive: true, force: true });}
    `;
    // A separate process bounds a blocking open in the old implementation.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5000, encoding: 'utf8'
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  });
}
