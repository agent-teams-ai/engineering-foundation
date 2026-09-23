import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { assertSupportedNodeTestRuntime, evaluateNodeTestEvents, validateNodeTestContract } from '../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.js';
import { mandatoryTestFile, writeMandatoryGateFixture } from '../scripts/mandatory-node-test-gate-fixture.mjs';

const packageRoot = resolve('packages/engineering-foundation');
const builtCli = join(packageRoot, 'dist/node-test-cli.js');
const gateCli = join(packageRoot, 'dist/cli.js');
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;
const identity = (file, names, kind = 'test') => ({ file, names, kind });
const contract = (required, exceptions = []) => ({ schemaVersion: 1, required, exceptions });
const exception = (item, status, platform = process.platform) => ({ ...item, status,
  reason: 'Reviewed fixture exception for the exact required case.', applicability: { platforms: [platform] } });
const testFile = mandatoryTestFile;
const selected = [{ absolute: '/fixture/cases.test.mjs', file: testFile }];
const event = (type, id, parentId, name, kind = 'test', other = {}) => ({ type, data: {
  entryFile: selected[0].absolute, file: selected[0].absolute, testId: id, parentId, name,
  ...(type === 'test:enqueue' ? { type: kind } : { details: { type: kind, passed: true } }), ...other,
} });
const successfulEvents = (nodes) => [
  ...nodes.flatMap(({ id, parentId = 0, name, kind = 'test', outcome = 'pass' }) => [
    event('test:enqueue', id, parentId, name, kind),
    event('test:complete', id, parentId, name, kind, outcome === 'pass' ? {} : { [outcome]: true }),
    event('test:pass', id, parentId, name, kind, outcome === 'pass' ? {} : { [outcome]: true }),
  ]),
  { type: 'test:summary', data: { entryFile: selected[0].absolute, success: true } },
  { type: 'test:summary', data: { success: true } },
];
const node = (id, name, parentId = 0, kind = 'test', outcome = 'pass') => ({ id, name, parentId, kind, outcome });

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'foundation-node-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function runFixture(root, source, required, exceptions = [], options = {}) {
  await writeFile(join(root, testFile), source);
  await writeFile(join(root, 'contract.json'), JSON.stringify(contract(required, exceptions)));
  const runnerPath = process.env.EF332_SOURCE_RUNNER ??
    join(packageRoot, 'dist/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.js');
  await writeFile(join(root, 'invoke.mjs'), `import { runNodeTestExecution } from ${JSON.stringify(pathToFileURL(runnerPath).href)};
await runNodeTestExecution({ root: ${JSON.stringify(options.rootAlias ?? root)}, files: ${JSON.stringify(options.selectedFiles ?? [testFile])},
  contractPath: 'contract.json', runOptions: ${options.testNamePatterns ? '{ testNamePatterns: [/unrelated/] }' : '{}'} });\n`);
  return spawnSync(process.execPath, [join(root, 'invoke.mjs')], { cwd: root, encoding: 'utf8', env: childEnvironment });
}

test('contract rejects empty, ambiguous, broad and malformed authority', () => {
  const item = identity(testFile, ['required']);
  assert.throws(() => validateNodeTestContract(contract([])), /nonempty/);
  assert.throws(() => validateNodeTestContract(contract([item, item])), /duplicate/);
  assert.throws(() => validateNodeTestContract(contract([item], [exception(item, 'skipped'), exception(item, 'skipped')])), /ambiguous/);
  assert.throws(() => validateNodeTestContract(contract([item], [{ ...exception(item, 'skipped'), applicability: { platforms: ['linux', 'darwin', 'win32'] } }])), /platform subset/);
  assert.throws(() => validateNodeTestContract(contract([identity('../escape', ['required'])])), /normalized/);
  assert.throws(() => validateNodeTestContract(contract([item], [exception(item, 'failed')])), /exact status/);
});

test('mandatory command requires event-capable Node 24.21 or later within major 24', () => {
  assert.throws(() => assertSupportedNodeTestRuntime('24.18.0'), /Node >=24\.21\.0 <25/);
  assert.throws(() => assertSupportedNodeTestRuntime('23.99.0'), /Node >=24\.21\.0 <25/);
  assert.throws(() => assertSupportedNodeTestRuntime('25.0.0'), /Node >=24\.21\.0 <25/);
  assert.doesNotThrow(() => assertSupportedNodeTestRuntime('24.21.0'));
});

test('event evidence needs unique completion, result, ancestry and selected file', () => {
  const required = identity(testFile, ['parent', 'child']);
  const nodes = [node(1, 'parent'), node(2, 'child', 1)];
  assert.equal(evaluateNodeTestEvents(successfulEvents(nodes), contract([required]), selected).protectedCount, 1);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents(nodes).filter((e) => e.type !== 'test:complete' || e.data?.name !== 'child'), contract([required]), selected), /lacks completion/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([...nodes, node(3, 'child', 1)]), contract([required]), selected), /ambiguous duplicate identity/);
  assert.throws(() => evaluateNodeTestEvents([successfulEvents(nodes)[0], ...successfulEvents(nodes)], contract([required]), selected), /duplicate or malformed enqueue/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents(nodes).map((e) => e.type === 'test:complete' && e.data?.name === 'child'
    ? { ...e, data: { ...e.data, testId: '2' } } : e), contract([required]), selected), /malformed/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(2, 'child', 1)]), contract([required]), selected), /missing test or suite ancestry/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents(nodes).map((e) => e.data?.name === 'child' ? { ...e, data: { ...e.data, entryFile: '/foreign/cases.test.mjs' } } : e), contract([required]), selected), /unselected/);
});

test('a failed result and an unsuccessful native summary always reject', () => {
  const required = identity(testFile, ['failed']);
  const events = successfulEvents([node(1, 'failed')]).map((item) => {
    if (item.type === 'test:summary') { return { ...item, data: { ...item.data, success: false } }; }
    if (item.type === 'test:pass') { return { ...item, type: 'test:fail' }; }
    if (item.type === 'test:complete') { return { ...item, data: { ...item.data, details: { type: 'test', passed: false } } }; }
    return item;
  });
  assert.throws(() => evaluateNodeTestEvents(events, contract([required]), selected), /failed/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'failed')]).map((item) => item.type === 'test:summary'
    ? { ...item, data: { ...item.data, success: false } } : item), contract([required]), selected), /unsuccessful/);
});

test('nested, skip, TODO and omissions fail unless an exact applicable exception exists', () => {
  const child = identity(testFile, ['parent', 'child']);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'parent'), node(2, 'child', 1, 'test', 'skip')]), contract([child]), selected), /skipped/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'parent'), node(2, 'child', 1, 'test', 'todo')]), contract([child]), selected), /todo/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'parent'), node(2, 'unrelated', 1)]), contract([child]), selected), /omitted/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'parent', 0, 'suite', 'skip')]), contract([child], [exception(child, 'omitted')]), selected), /unexecuted ancestor/);
  assert.equal(evaluateNodeTestEvents(successfulEvents([node(1, 'parent'), node(2, 'child', 1, 'test', 'skip')]), contract([child], [exception(child, 'skipped')]), selected).protectedCount, 1);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'parent'), node(2, 'child', 1, 'test', 'skip')]), contract([child], [exception(child, 'skipped', 'unsupported')]), selected), /platform subset/);
  assert.throws(() => evaluateNodeTestEvents(successfulEvents([node(1, 'parent')]), contract([identity('other.test.mjs', ['parent'])]), selected), /no mandatory identities/);
  assert.equal(evaluateNodeTestEvents(successfulEvents([node(1, 'parent')]), contract([identity(testFile, ['parent']), identity('other.test.mjs', ['other'])]), selected).protectedCount, 1);
});

test('actual Node run evidence rejects skip, filtered omission and conditional omission', async () => fixture(async (root) => {
  const required = [identity(testFile, ['parent', 'child'])];
  const skipped = await runFixture(root, "import test from 'node:test'; test('parent', async t => { await t.test('child', { skip: true }, () => {}); });", required);
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /skipped/);
  const skippedSuite = await runFixture(root, "import { describe, it } from 'node:test'; describe.skip('parent', () => { it('child', () => {}); });", required);
  assert.equal(skippedSuite.status, 1);
  const todo = await runFixture(root, "import test from 'node:test'; test('parent', async t => { await t.test('child', { todo: true }, () => {}); });", required);
  assert.equal(todo.status, 1);
  assert.match(todo.stderr, /todo/);
  const omitted = await runFixture(root, "import test from 'node:test'; test('parent', async t => { await t.test('other', () => {}); });", required);
  assert.equal(omitted.status, 1);
  assert.match(omitted.stderr, /omitted/);
  const conditional = await runFixture(root, "import test from 'node:test'; test('parent', async t => { if (false) await t.test('child', () => {}); await t.test('other', () => {}); });", required);
  assert.equal(conditional.status, 1);
  assert.match(conditional.stderr, /omitted/);
  const filtered = await runFixture(root, "import test from 'node:test'; test('parent', async t => { await t.test('child', () => {}); });", required, [], { testNamePatterns: [/unrelated/] });
  assert.equal(filtered.status, 1);
  const passed = await runFixture(root, "import test from 'node:test'; test('parent', async t => { await t.test('child', () => {}); });", required);
  assert.equal(passed.status, 0, passed.stderr);
}));

test('canonical root aliases are accepted; escaped and symlinked entries reject', async () => fixture(async (root) => {
  const required = [identity(testFile, ['required'])];
  const source = "import test from 'node:test'; test('required', () => {});";
  const alias = join(root, 'root-alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = await runFixture(root, source, required, [], { rootAlias: alias });
  assert.equal(aliased.status, 0, aliased.stderr);
  if (process.platform !== 'win32') {
    await symlink(join(root, testFile), join(root, 'linked.test.mjs'));
    const linked = await runFixture(root, source, [identity('linked.test.mjs', ['required'])], [],
      { selectedFiles: ['linked.test.mjs'] });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /not a real entry file/);
  }
  const escaped = await runFixture(root, source, required, [], { selectedFiles: ['../escaped.test.mjs'] });
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /invalid selected file/);
}));

test('public gate run built route propagates mandatory outcomes', async () => fixture(async (root) => {
    const required = [identity(testFile, ['required'])];
    for (const [source, expected] of [
      ["import test from 'node:test'; test.skip('required', () => {});", 1],
      ["import test from 'node:test'; test('unrelated', () => {});", 1],
      ["import test from 'node:test'; test('required', () => {});", 0],
    ]) {
      await writeMandatoryGateFixture({ root, commandPath: builtCli, source, required });
      const result = spawnSync(process.execPath, [gateCli, 'gate', 'run', 'verify', '--consumer', root, '--format', 'json'],
        { cwd: root, encoding: 'utf8', env: childEnvironment });
      assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    }
    await writeMandatoryGateFixture({ root, commandPath: builtCli,
      source: "import test from 'node:test'; test.skip('required', () => {});",
      required, exceptions: [exception(required[0], 'skipped')] });
    const skipped = spawnSync(process.execPath, [gateCli, 'gate', 'run', 'verify', '--consumer', root, '--format', 'json'],
      { cwd: root, encoding: 'utf8', env: childEnvironment });
    assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
}));
