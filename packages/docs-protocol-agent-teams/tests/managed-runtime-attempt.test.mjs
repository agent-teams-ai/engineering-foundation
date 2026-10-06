import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, parent, workspace } from './managed-runtime-fixtures.mjs';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';

const build = '1'.repeat(64); // Test-only controller identity, never a production build receipt.
test('packed private runtime modules exist, parse, and carry no workspace runtime import', async () => {
  const tools = await fixture('node24');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'TEST-managed-runtime-pack-'));
  try {
    const node = tools.node;
    const pnpm = join(tools.packageRoot, 'bin/pnpm.mjs');
    execFileSync(node, [pnpm, '--dir', join(workspace, 'packages/docs-protocol-agent-teams'),
      'pack', '--pack-destination', root], { stdio: 'pipe' });
    const tarballs = (await readdir(root)).filter(name => name.endsWith('.tgz'));
    assert.equal(tarballs.length, 1);
    const tarball = join(root, tarballs[0]);
    const contents = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
    for (const file of ['managed-runtime-probe.js', 'node-managed-runtime-attempt.js',
      'node-managed-runtime-install.js']) {
      assert.ok(contents.includes(`package/dist/consumer-integration/adapters/${file}`));
    }
    assert.equal(contents.some(path => path.startsWith('package/src/') || path.includes('.local/')), false);
    execFileSync('tar', ['-xzf', tarball, '-C', root]);
    for (const file of ['managed-runtime-probe.js', 'node-managed-runtime-attempt.js',
      'node-managed-runtime-install.js']) {
      const path = join(root, 'package/dist/consumer-integration/adapters', file);
      execFileSync(node, ['--check', path]);
      const source = await readFile(path, 'utf8');
      assert.doesNotMatch(source, /@agent-teams\/engineering-foundation|\.local\/|\/src\//);
    }
  } finally {await rm(root, { recursive: true, force: true }); await tools.cleanup();}
});
async function prepared() {
  const f = await fixture('node24');
  const external = join(f.root, 'TEST-attempt-records');
  const consumer = join(f.root, 'TEST-consumer');
  await Promise.all([mkdir(external), mkdir(consumer)]);
  const controller = new AbortController();
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection: f.selection,
    signal: controller.signal });
  const admission = await scope.admit();
  assert.equal(admission.outcome, 'admitted');
  const input = { externalRoot: external, consumerRoot: consumer,
    controllerBuildDigest: build, role: 'source', runtime: admission.runtime,
    signal: controller.signal };
  return { f, scope, input };
}

test('exclusive attempt refuses concurrent same-root acquisition before any child and releases exact record', async () => {
  const x = await prepared();
  try {
    const first = await x.scope.acquireAttempt(x.input);
    assert.equal(first.outcome, 'acquired');
    assert.equal('transition' in first.attempt, false);
    const forged = await x.scope.install({ root: { kind: 'managed-owned-installation-root' },
      runtime: x.input.runtime, mode: 'prepare', expectedManifestDigest: '1'.repeat(64),
      expectedWorkspaceDigest: '2'.repeat(64), expectedLockDigest: null,
      signal: x.input.signal });
    assert.equal(forged.outcome, 'refused');
    assert.equal(forged.facts.spawned, false);
    const secondScope = createNodeManagedRuntimeScope({ privateRoot: x.f.root,
      selection: x.f.selection, signal: x.input.signal });
    const secondAdmission = await secondScope.admit();
    assert.equal(secondAdmission.outcome, 'admitted');
    const second = await secondScope.acquireAttempt({ ...x.input, runtime: secondAdmission.runtime });
    assert.equal(second.outcome, 'refused');
    assert.equal(second.code, 'liveness-uncertain');
    const record = JSON.parse(await readFile(first.attempt.evidencePath, 'utf8'));
    assert.equal(record.format, 'agent-teams.managed-runtime-attempt/v1');
    assert.equal(record.token, first.attempt.token);
    assert.equal(record.runtime.node, x.f.trusted.nodeSha);
    assert.equal(record.runtime.pnpmTree, x.f.trusted.treeSha);
    assert.equal(record.ownedRoots[0].path, first.attempt.ownedRoot);
    assert.deepEqual(record.installation, []);
    assert.deepEqual(record.backup, []);
    assert.equal(record.preparationDigest, null);
    assert.deepEqual(await first.attempt.close(), { outcome: 'closed' });
    assert.equal(x.scope.ownedInstallationRoot(), null);
    assert.equal((await readdir(x.input.externalRoot)).length, 0);
    assert.equal((await secondScope.close()).outcome, 'closed');
  } finally {await x.scope.close(); await x.f.cleanup();}
});

test('independent physical consumer roots acquire distinct attempt records', async () => {
  const x = await prepared();
  try {
    const first = await x.scope.acquireAttempt(x.input);
    assert.equal(first.outcome, 'acquired');
    const secondConsumer = join(x.f.root, 'TEST-second-consumer');
    await mkdir(secondConsumer);
    const secondScope = createNodeManagedRuntimeScope({ privateRoot: x.f.root,
      selection: x.f.selection, signal: x.input.signal });
    const secondAdmission = await secondScope.admit();
    assert.equal(secondAdmission.outcome, 'admitted');
    const second = await secondScope.acquireAttempt({ ...x.input, consumerRoot: secondConsumer,
      runtime: secondAdmission.runtime });
    assert.equal(second.outcome, 'acquired');
    assert.notEqual(first.attempt.evidencePath, second.attempt.evidencePath);
    assert.notEqual(first.attempt.ownedRoot, second.attempt.ownedRoot);
    assert.equal((await secondScope.close()).outcome, 'closed');
  } finally {await x.scope.close(); await x.f.cleanup();}
});

test('substituted attempt record retains debt and never removes foreign bytes', async () => {
  const x = await prepared();
  try {
    const result = await x.scope.acquireAttempt(x.input);
    assert.equal(result.outcome, 'acquired');
    const path = result.attempt.evidencePath;
    await writeFile(path, 'foreign-token\n');
    const close = await result.attempt.close();
    assert.equal(close.outcome, 'debt');
    assert.equal(await readFile(path, 'utf8'), 'foreign-token\n');
    const replay = await x.scope.acquireAttempt(x.input);
    assert.equal(replay.outcome, 'refused');
  } finally {await x.scope.close(); await x.f.cleanup();}
});

test('physical consumer replacement keeps owned root and record as cleanup debt', async () => {
  const x = await prepared();
  try {
    const acquired = await x.scope.acquireAttempt(x.input);
    assert.equal(acquired.outcome, 'acquired');
    await rename(x.input.consumerRoot, `${x.input.consumerRoot}-old`);
    await mkdir(x.input.consumerRoot);
    const close = await acquired.attempt.close();
    assert.equal(close.outcome, 'debt');
    assert.equal(close.debt.code, 'cleanup-failed');
    assert.equal((await readFile(acquired.attempt.evidencePath, 'utf8')).includes('"phase":"debt"'), true);
    assert.equal((await readdir(x.input.externalRoot)).some(name => name.startsWith('managed-runtime-owned-')), true);
  } finally {await x.scope.close(); await x.f.cleanup();}
});

test('owned installation root replacement refuses before spawn and retains debt', async () => {
  const x = await prepared();
  try {
    const acquired = await x.scope.acquireAttempt(x.input);
    assert.equal(acquired.outcome, 'acquired');
    const handle = x.scope.ownedInstallationRoot();
    await rename(acquired.attempt.ownedRoot, `${acquired.attempt.ownedRoot}-old`);
    await mkdir(acquired.attempt.ownedRoot);
    const result = await x.scope.install({ root: handle, runtime: x.input.runtime, mode: 'prepare',
      expectedManifestDigest: '1'.repeat(64), expectedWorkspaceDigest: '2'.repeat(64),
      expectedLockDigest: null, signal: x.input.signal });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'identity-changed');
    assert.equal(result.facts.spawned, false);
    assert.equal((await acquired.attempt.close()).outcome, 'debt');
    assert.equal((await readFile(acquired.attempt.evidencePath, 'utf8')).includes('"phase":"debt"'), true);
  } finally {await x.scope.close(); await x.f.cleanup();}
});

test('controller death leaves exclusive acquired record as a restart refusal barrier', async () => {
  const x = await prepared();
  const script = join(x.f.root, 'TEST-controller.mjs');
  const module = new URL('../dist/consumer-integration/adapters/node-managed-runtime.js', import.meta.url).href;
  await writeFile(script, `import { createNodeManagedRuntimeScope } from ${JSON.stringify(module)};
    const scope = createNodeManagedRuntimeScope({ privateRoot: process.env.TEST_ROOT,
      selection: JSON.parse(process.env.TEST_SELECTION), signal: new AbortController().signal });
    const admission = await scope.admit();
    if (admission.outcome !== 'admitted') process.exit(2);
    const acquired = await scope.acquireAttempt({ externalRoot: process.env.TEST_EXTERNAL,
      consumerRoot: process.env.TEST_CONSUMER, controllerBuildDigest: '${build}',
      role: 'source', runtime: admission.runtime, signal: new AbortController().signal });
    if (acquired.outcome !== 'acquired') process.exit(3);
    process.send({ path: acquired.attempt.evidencePath });
    setInterval(() => {}, 1000);
  `);
  const worker = spawn(x.f.node, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { TEST_ROOT: x.f.root, TEST_SELECTION: JSON.stringify(x.f.selection),
      TEST_EXTERNAL: x.input.externalRoot, TEST_CONSUMER: x.input.consumerRoot } });
  try {
    const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.equal(typeof message.path, 'string');
    worker.kill('SIGKILL');
    await once(worker, 'close');
    const retained = JSON.parse(await readFile(message.path, 'utf8'));
    assert.equal(retained.phase, 'acquired');
    assert.equal(retained.controller.pid, worker.pid);
    const retry = await x.scope.acquireAttempt(x.input);
    assert.equal(retry.outcome, 'refused');
    assert.equal(retry.code, 'liveness-uncertain');
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {worker.kill('SIGKILL'); await once(worker, 'close');}
    await x.scope.close();
    await x.f.cleanup();
  }
});

test('controller death after durable child identity retains debt and refuses restart', async () => {
  const x = await prepared();
  const script = join(x.f.root, 'TEST-running-controller.mjs');
  const module = new URL('../dist/consumer-integration/adapters/node-managed-runtime.js', import.meta.url).href;
  await writeFile(script, `import { createNodeManagedRuntimeScope } from ${JSON.stringify(module)};
    import { randomBytes, createHash } from 'node:crypto';
    import { execFileSync } from 'node:child_process';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const sha = value => createHash('sha256').update(value).digest('hex');
    const signal = new AbortController().signal;
    const scope = createNodeManagedRuntimeScope({ privateRoot: process.env.TEST_ROOT,
      selection: JSON.parse(process.env.TEST_SELECTION), signal });
    const admission = await scope.admit();
    if (admission.outcome !== 'admitted') process.exit(2);
    const acquired = await scope.acquireAttempt({ externalRoot: process.env.TEST_EXTERNAL,
      consumerRoot: process.env.TEST_CONSUMER, controllerBuildDigest: '${build}',
      role: 'source', runtime: admission.runtime, signal });
    if (acquired.outcome !== 'acquired') process.exit(3);
    const root = acquired.attempt.ownedRoot;
    const dir = join(root, 'TEST-large/package');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'large', version: '1.0.0' }));
    await writeFile(join(dir, 'payload.bin'), randomBytes(16 * 1024 * 1024));
    execFileSync('tar', ['-czf', join(root, 'large.tgz'), '-C', join(root, 'TEST-large'), 'package']);
    const manifest = JSON.stringify({ name: 'test-crash', version: '1.0.0', private: true,
      packageManager: 'pnpm@11.20.0', dependencies: { large: 'file:./large.tgz' } }) + '\\n';
    const workspace = 'packages: []\\n';
    await writeFile(join(root, 'package.json'), manifest);
    await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
    process.send({ path: acquired.attempt.evidencePath });
    await scope.install({ root: scope.ownedInstallationRoot(), runtime: admission.runtime,
      mode: 'prepare', expectedManifestDigest: sha(manifest), expectedWorkspaceDigest: sha(workspace),
      expectedLockDigest: null, signal });
    setInterval(() => {}, 1000);
  `);
  const worker = spawn(x.f.node, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { TEST_ROOT: x.f.root, TEST_SELECTION: JSON.stringify(x.f.selection),
      TEST_EXTERNAL: x.input.externalRoot, TEST_CONSUMER: x.input.consumerRoot,
      PATH: process.env.PATH } });
  let childPid = null;
  try {
    const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(15_000) });
    const deadline = Date.now() + 15_000;
    let running = null;
    while (Date.now() < deadline) {
      try {
        const record = JSON.parse(await readFile(message.path, 'utf8'));
        if (record.phase === 'running' && record.child) {running = record; break;}
      } catch { /* Wait for a fully synced phase record. */ }
      await new Promise(resolve => {setTimeout(resolve, 5);});
    }
    assert.ok(running, 'selected child identity was durably recorded');
    childPid = running.child.pid;
    worker.kill('SIGKILL');
    await once(worker, 'close');
    const stat = (await readFile(`/proc/${childPid}/stat`, 'utf8')).split(') ')[1].split(' ');
    assert.equal(stat[19], running.child.start);
    process.kill(-running.child.pgid, 'SIGKILL'); // Test supervisor independently stops its fixture child.
    const stopDeadline = Date.now() + 5_000;
    let stopped = false;
    while (Date.now() < stopDeadline) {
      try {
        const current = (await readFile(`/proc/${childPid}/stat`, 'utf8')).split(') ')[1].split(' ');
        if (current[0] === 'Z' || current[0] === 'X') {stopped = true; break;}
      } catch {stopped = true; break;}
      await new Promise(resolve => {setTimeout(resolve, 10);});
    }
    assert.equal(stopped, true, 'test-owned child exited before fixture cleanup');
    const retry = await x.scope.acquireAttempt(x.input);
    assert.equal(retry.outcome, 'refused');
    assert.equal(retry.code, 'liveness-uncertain');
    const retained = JSON.parse(await readFile(message.path, 'utf8'));
    assert.equal(retained.phase, 'running');
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {worker.kill('SIGKILL'); await once(worker, 'close');}
    if (childPid) {try {process.kill(-childPid, 'SIGKILL');} catch {}}
    await x.scope.close();
    await x.f.cleanup();
  }
});
