import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { mandatoryTestFile, writeMandatoryGateFixture } from '../scripts/mandatory-node-test-gate-fixture.mjs';

const packageRoot = resolve('packages/engineering-foundation');
const sourceRunner = join(packageRoot, 'src/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.ts');
const runnerPath = process.env.EF332_SOURCE_RUNNER ?? sourceRunner;
import { assertSupportedNodeTestRuntime, evaluateNodeTestEvents, validateNodeTestContract }
  from "../packages/engineering-foundation/src/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.ts";
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
  await options.prepareContract?.(root);
  await writeFile(join(root, 'invoke.mjs'), `import { runNodeTestExecution } from ${JSON.stringify(pathToFileURL(runnerPath).href)};
await runNodeTestExecution({ root: ${JSON.stringify(options.rootAlias ?? root)}, files: ${JSON.stringify(options.selectedFiles ?? [testFile])},
  contractPath: 'contract.json', runOptions: ${options.testNamePatterns ? '{ testNamePatterns: [/unrelated/] }'
    : options.isolation ? JSON.stringify({ isolation: options.isolation }) : '{}'} });\n`);
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

test('mandatory command keeps Node 24 default and accepts the Node 26 compatibility lane', () => {
  assert.throws(() => assertSupportedNodeTestRuntime('24.18.0'), /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/);
  assert.throws(() => assertSupportedNodeTestRuntime('24.20.0'), /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/);
  assert.throws(() => assertSupportedNodeTestRuntime('23.99.0'), /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/);
  assert.throws(() => assertSupportedNodeTestRuntime('25.0.0'), /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/);
  assert.throws(() => assertSupportedNodeTestRuntime('27.0.0'), /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/);
  assert.doesNotThrow(() => assertSupportedNodeTestRuntime('24.21.0'));
  assert.doesNotThrow(() => assertSupportedNodeTestRuntime('26.0.0'));
  assert.doesNotThrow(() => assertSupportedNodeTestRuntime('26.10.0'));
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

test('expected-failure evidence rejects even with passing completion and summaries', () => {
  const required = identity(testFile, ['required']);
  const ordinary = successfulEvents([node(1, 'required')]);
  assert.equal(evaluateNodeTestEvents(ordinary, contract([required]), selected).protectedCount, 1);
  for (const type of ['test:enqueue', 'test:complete', 'test:pass']) {
    for (const value of [true, 'reviewed failure']) {
      const expectedFailure = ordinary.map((item) => item.type === type
        ? { ...item, data: { ...item.data, expectFailure: value } } : item);
      assert.throws(() => evaluateNodeTestEvents(expectedFailure, contract([required]), selected), /expected failure/);
    }
    for (const malformed of [null, undefined, 0, 1, {}, []]) {
      const invalid = successfulEvents([node(1, 'required'), node(2, 'unrelated')]).map((item) =>
        item.type === type && item.data?.name === 'unrelated'
          ? { ...item, data: { ...item.data, expectFailure: malformed } } : item);
      assert.throws(() => evaluateNodeTestEvents(invalid, contract([required]), selected), /malformed expectFailure directive/);
    }
  }
  const inactive = ordinary.map((item) => item.type === 'test:pass'
    ? { ...item, data: { ...item.data, expectFailure: false } } : item);
  assert.equal(evaluateNodeTestEvents(inactive, contract([required]), selected).protectedCount, 1);
  const child = identity(testFile, ['parent', 'child']);
  const inherited = successfulEvents([node(1, 'parent'), node(2, 'child', 1)]).map((item) =>
    item.type === 'test:pass' && item.data?.name === 'parent'
      ? { ...item, data: { ...item.data, expectFailure: true } } : item);
  assert.throws(() => evaluateNodeTestEvents(inherited, contract([child]), selected), /expected failure/);
  assert.throws(() => evaluateNodeTestEvents(inherited, contract([child], [exception(child, 'todo')]), selected), /expected failure/);
  const malformedSummary = ordinary.map((item) => item.type === 'test:summary'
    ? { ...item, data: { ...item.data, expectFailure: null } } : item);
  assert.throws(() => evaluateNodeTestEvents(malformedSummary, contract([required]), selected), /malformed expectFailure directive/);
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

test('directive evidence accepts empty strings and rejects malformed values across observed entries', () => {
  const required = identity(testFile, ['required']);
  for (const directive of ['skip', 'todo']) {
    const status = directive === 'skip' ? 'skipped' : 'todo';
    const events = successfulEvents([node(1, 'required')]).map((item) =>
      item.type === 'test:pass' ? { ...item, data: { ...item.data, [directive]: '' } } : item);
    assert.throws(() => evaluateNodeTestEvents(events, contract([required]), selected), new RegExp(status));
    assert.equal(evaluateNodeTestEvents(events, contract([required], [exception(required, status)]), selected).protectedCount, 1);
    for (const type of ['test:enqueue', 'test:complete', 'test:pass']) {
      for (const malformed of [null, undefined, 0, 1, {}, []]) {
        const invalid = successfulEvents([node(1, 'required'), node(2, 'unrelated')]).map((item) =>
          item.type === type && item.data?.name === 'unrelated'
            ? { ...item, data: { ...item.data, [directive]: malformed } } : item);
        assert.throws(() => evaluateNodeTestEvents(invalid, contract([required]), selected), /malformed .* directive/);
      }
    }
  }
  const inactive = successfulEvents([node(1, 'required')]).map((item) =>
    item.type === 'test:pass' ? { ...item, data: { ...item.data, skip: false, todo: false } } : item);
  assert.equal(evaluateNodeTestEvents(inactive, contract([required]), selected).protectedCount, 1);
  const enqueueSkip = successfulEvents([node(1, 'required')]).map((item) =>
    item.type === 'test:enqueue' ? { ...item, data: { ...item.data, skip: '' } } : item);
  assert.throws(() => evaluateNodeTestEvents(enqueueSkip, contract([required]), selected), /skipped/);
  const conflicting = successfulEvents([node(1, 'required'), node(2, 'unrelated')]).map((item) =>
    item.data?.name === 'unrelated' && item.type === 'test:complete'
      ? { ...item, data: { ...item.data, skip: '' } }
      : item.data?.name === 'unrelated' && item.type === 'test:pass'
        ? { ...item, data: { ...item.data, todo: '' } } : item);
  assert.throws(() => evaluateNodeTestEvents(conflicting, contract([required]), selected), /conflicting/);
  const malformedSummary = successfulEvents([node(1, 'required')]).map((item) =>
    item.type === 'test:summary' ? { ...item, data: { ...item.data, skip: null } } : item);
  assert.throws(() => evaluateNodeTestEvents(malformedSummary, contract([required]), selected), /malformed skip directive/);
  const skippedWrapper = [
    { type: 'test:pass', data: { file: selected[0].absolute, name: selected[0].absolute, parentId: 0, skip: '' } },
    ...successfulEvents([node(1, 'required')]),
  ];
  assert.throws(() => evaluateNodeTestEvents(skippedWrapper, contract([required]), selected), /directive outside a test identity/);
});

test('empty-reason directive on a required ancestor prevents descendant qualification', () => {
  const child = identity(testFile, ['parent', 'child']);
  const events = successfulEvents([node(1, 'parent'), node(2, 'child', 1)]).map((item) =>
    item.type === 'test:pass' && item.data?.name === 'parent'
      ? { ...item, data: { ...item.data, skip: '' } } : item);
  assert.throws(() => evaluateNodeTestEvents(events, contract([child]), selected), /unexecuted ancestor/);
});

test('actual Node empty-reason skip and TODO evidence requires exact exceptions', async () => fixture(async (root) => {
  const required = [identity(testFile, ['required'])];
  for (const [source, status] of [
    ["import test from 'node:test'; test('required', t => t.skip(''));", 'skipped'],
    ["import test from 'node:test'; test('required', t => t.todo(''));", 'todo'],
  ]) {
    const rejected = await runFixture(root, source, required);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, new RegExp(status));
    const allowed = await runFixture(root, source, required, [exception(required[0], status)]);
    assert.equal(allowed.status, 0, allowed.stderr);
  }
  const child = [identity(testFile, ['parent', 'child'])];
  const parentSkipped = await runFixture(root,
    "import test from 'node:test'; test('parent', async t => { t.skip(''); await t.test('child', () => {}); });",
    child, [exception(child[0], 'omitted')]);
  assert.equal(parentSkipped.status, 1, parentSkipped.stderr);
  assert.match(parentSkipped.stderr, /unexecuted ancestor/);
}));

test('actual Node expected assertion failure cannot satisfy a required identity', async () => fixture(async (root) => {
  const required = [identity(testFile, ['required'])];
  const expectedFailure = await runFixture(root,
    "import assert from 'node:assert/strict'; import test from 'node:test'; test('required', { expectFailure: true }, () => assert.equal(1, 2));",
    required);
  assert.equal(expectedFailure.status, 1, expectedFailure.stderr);
  assert.match(expectedFailure.stderr, /expected failure/);
  const ordinaryPass = await runFixture(root,
    "import assert from 'node:assert/strict'; import test from 'node:test'; test('required', () => assert.equal(1, 1));",
    required);
  assert.equal(ordinaryPass.status, 0, ordinaryPass.stderr);
}));

test('actual Node assertion failures print their real diagnostic details', async () => fixture(async (root) => {
  const required = [identity(testFile, ['diagnostic outer marker', 'diagnostic child marker'])];
  const source = `import assert from 'node:assert/strict';
import test from 'node:test';
test('diagnostic outer marker', async (t) => {
  await t.test('diagnostic child marker', () => {
    assert.equal('actual-diagnostic-value', 'expected-diagnostic-value');
  });
});`;
  const result = await runFixture(root, source, required);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node test execution contract: failed test execution:/u);
  const lines = result.stdout.split('\n');
  const header = lines.indexOf('FAIL diagnostic child marker');
  assert.ok(header >= 0, result.stdout);
  // The diagnostic is one JSON record: the AssertionError must be reached through the cause chain.
  const top = JSON.parse(lines[header + 1]);
  let level = top;
  for (let depth = 0; depth < 3 && level?.name !== 'AssertionError'; depth++) { level = level?.cause; }
  assert.equal(level?.name, 'AssertionError', lines[header + 1]);
  assert.notEqual(level, top, 'AssertionError must be nested as a cause of the test failure');
  assert.equal(level.code, 'ERR_ASSERTION');
  assert.equal(level.operator, 'strictEqual');
  assert.equal(level.actual, 'actual-diagnostic-value');
  assert.equal(level.expected, 'expected-diagnostic-value');
  assert.match(level.location[0], /cases\.test\.mjs:5:12/u);
}));

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

test('a symlinked mandatory contract cannot supply execution authority', async () => fixture(async (root) => {
  const required = [identity(testFile, ['required'])];
  const source = "import test from 'node:test'; test('required', () => {});";
  const result = await runFixture(root, source, required, [], { prepareContract: async (directory) => {
    const contractPath = join(directory, 'contract.json');
    await writeFile(join(directory, 'foreign.json'), JSON.stringify(contract(required)));
    await unlink(contractPath);
    await symlink(join(directory, 'foreign.json'), contractPath);
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contract must be a real regular file/);
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

test('public mandatory CLI boots independently under a real Node test parent', async () => fixture(async (root) => {
  const child = identity(testFile, ['parent', 'child']);
  const secondFile = 'second.test.mjs';
  const second = identity(secondFile, ['second required']);
  const unselectedFile = 'unselected.test.mjs';
  const required = [child, second, identity(unselectedFile, ['unselected'])];
  const passing = `import assert from 'node:assert/strict'; import test from 'node:test';
test('parent', async t => { await t.test('child', () => {
  assert.equal(process.env.EF_NODE_TEST_CLI_INPUT, 'retained input');
  assert.equal(process.env.NODE_OPTIONS, process.env.EF_NODE_TEST_CLI_EXPECTED_NODE_OPTIONS);
  assert.equal(process.env.EF_NODE_TEST_CLI_PRELOAD_COUNT, process.env.EF_NODE_TEST_CLI_EXPECTED_PRELOAD_COUNT);
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
}); });`;
  const skipped = "import test from 'node:test'; test('parent', async t => { await t.test('child', { skip: true }, () => {}); });";
  const omitted = "import test from 'node:test'; test('parent', async t => { await t.test('other', () => {}); });";
  const scenarios = [
    { label: 'completed selected identities', source: passing, status: 0 },
    { label: 'unexcepted skip', source: skipped, status: 1, diagnostic: 'skipped' },
    { label: 'unexcepted omission', source: omitted, status: 1, diagnostic: 'omitted' },
    { label: 'missing identity in second selected file', source: passing,
      secondSource: "import test from 'node:test'; test('other', () => {});", status: 1, diagnostic: 'omitted' },
    { label: 'exact applicable skip exception', source: skipped, status: 0,
      exceptions: [exception(child, 'skipped')] },
    { label: 'exception for another OS', source: skipped, status: 1, diagnostic: 'skipped',
      exceptions: [exception(child, 'skipped', process.platform === 'win32' ? 'linux' : 'win32')] },
    { label: 'omission exception cannot excuse skip', source: skipped, status: 1, diagnostic: 'skipped',
      exceptions: [exception(child, 'omitted')] },
    { label: 'skip exception cannot excuse omission', source: omitted, status: 1, diagnostic: 'omitted',
      exceptions: [exception(child, 'skipped')] },
    { label: 'exception for another identity', source: skipped, status: 1, diagnostic: 'skipped',
      exceptions: [exception(second, 'skipped')] },
  ];
  await writeFile(join(root, unselectedFile), "throw new Error('unselected entry must not execute');");
  await writeFile(join(root, 'ordinary.test.mjs'), `import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('ordinary selected entry', () => writeFileSync('ordinary-ran', 'completed'));`);
  const preload = join(root, 'preload.mjs');
  await writeFile(preload, `process.env.EF_NODE_TEST_CLI_PRELOAD_COUNT =
String(Number(process.env.EF_NODE_TEST_CLI_PRELOAD_COUNT ?? 0) + 1);`);
  await writeFile(join(root, 'parent.test.mjs'), `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
const required = ${JSON.stringify(required)};
const scenarios = ${JSON.stringify(scenarios)};
for (const scenario of scenarios) {
  test(scenario.label, async () => {
    assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
    await rm('ordinary-ran', { force: true });
    await writeFile(${JSON.stringify(testFile)}, scenario.source);
    await writeFile(${JSON.stringify(secondFile)}, scenario.secondSource ??
      "import test from 'node:test'; test('second required', () => {});");
    await writeFile('contract.json', JSON.stringify({ schemaVersion: 1, required,
      exceptions: scenario.exceptions ?? [] }));
    process.env.EF_NODE_TEST_CLI_EXPECTED_PRELOAD_COUNT =
      String(Number(process.env.EF_NODE_TEST_CLI_PRELOAD_COUNT) + 2);
    const result = spawnSync(process.execPath,
      [${JSON.stringify(builtCli)}, '--contract', 'contract.json', '--',
        ${JSON.stringify(testFile)}, ${JSON.stringify(secondFile)}, 'ordinary.test.mjs'],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30000 });
    console.log(JSON.stringify({ label: scenario.label, context: process.env.NODE_TEST_CONTEXT,
      status: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, scenario.status, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /recursively|missing final or file summary/);
    assert.equal(await readFile('ordinary-ran', 'utf8'), 'completed');
    if (scenario.status === 0) {
      assert.equal(result.stdout, 'Mandatory Node tests: 2 required identities completed or exactly excepted\\n');
      assert.equal(result.stderr, '');
    } else {
      assert.match(result.stderr, /Node test execution contract: required execution failed:/);
      assert.ok(result.stderr.includes(scenario.diagnostic), result.stderr);
      assert.doesNotMatch(result.stdout, /Mandatory Node tests:/);
    }
    assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
  });
}
`);
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`;
  const parent = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(root, 'parent.test.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...childEnvironment, EF_NODE_TEST_CLI_INPUT: 'retained input', EF_NODE_TEST_CLI_PRELOAD_COUNT: '0',
      NODE_OPTIONS: nodeOptions, EF_NODE_TEST_CLI_EXPECTED_NODE_OPTIONS: nodeOptions },
  });
  assert.equal(parent.error, undefined);
  assert.equal(parent.signal, null);
  assert.equal(parent.status, 0, `${parent.stdout}\n${parent.stderr}`);
}));

test('Foundation mandatory selection rejects unexecuted cases and preserves unadopted tests', async (t) => fixture(async (root) => {
  const contractPath = join(root, 'architecture/foundation/node-test-execution.json');
  await mkdir(join(root, 'architecture/foundation'), { recursive: true });
  await writeFile(join(root, 'invoke.mjs'), `import { maybeRunMandatoryNodeTests, runUnadoptedNodeTests }
  from ${JSON.stringify(pathToFileURL(resolve('scripts/mandatory-node-test.mjs')).href)};
const files = process.argv.slice(2);
process.exitCode = await maybeRunMandatoryNodeTests(files, {}, ${JSON.stringify(root)}) ??
  await runUnadoptedNodeTests(files);\n`);
  const required = identity(testFile, ['parent', 'child']);
  const writeContract = async (exceptions = []) => writeFile(contractPath,
    JSON.stringify(contract([required], exceptions)));
  const runCase = async (source) => {
    await writeFile(join(root, testFile), source);
    return spawnSync(process.execPath, [join(root, 'invoke.mjs'), testFile],
      { cwd: root, encoding: 'utf8', env: childEnvironment });
  };
  const passing = "import { describe, it } from 'node:test'; describe('parent', () => { it('child', () => {}); });";
  await t.test('required pass, skip, TODO and omission', async () => {
    await writeContract();
    const passed = await runCase(passing);
    assert.equal(passed.status, 0, passed.stderr);
    for (const [label, source] of [
      ['skipped case', "import { describe, it } from 'node:test'; describe('parent', () => { it.skip('child', () => {}); });"],
      ['TODO case', "import { describe, it } from 'node:test'; describe('parent', () => { it.todo('child'); });"],
      ['skipped suite', "import { describe, it } from 'node:test'; describe.skip('parent', () => { it('child', () => {}); });"],
      ['omitted case', "import { describe, it } from 'node:test'; describe('parent', () => { it('other', () => {}); });"],
    ]) {
      assert.equal((await runCase(source)).status, 1, label);
    }
  });
  await t.test('missing contract fails closed', async () => {
    await unlink(contractPath);
    const missing = await runCase(passing);
    assert.equal(missing.status, 1, 'missing contract must fail closed');
    assert.match(missing.stderr, /ENOENT.*node-test-execution\.json/u);
  });
  const skipped = "import { describe, it } from 'node:test'; describe('parent', () => { it.skip('child', () => {}); });";
  await t.test('platform-scoped exception', async () => {
    await writeContract([exception(required, 'skipped')]);
    assert.equal((await runCase(skipped)).status, 0, 'applicable platform exception');
    await writeContract([exception(required, 'skipped', process.platform === 'win32' ? 'linux' : 'win32')]);
    assert.equal((await runCase(skipped)).status, 1, 'inapplicable platform exception');
  });
  const unadopted = join(root, 'unadopted.test.mjs');
  await t.test('mixed mandatory and skipped unadopted selection', async () => {
    await writeContract();
    await writeFile(join(root, testFile), passing);
    await writeFile(unadopted, "import test from 'node:test'; test.skip('platform-only advisory case', () => {});");
    const mixedRun = spawnSync(process.execPath, [join(root, 'invoke.mjs'), testFile, 'unadopted.test.mjs'],
      { cwd: root, encoding: 'utf8', env: childEnvironment });
    assert.equal(mixedRun.status, 0, mixedRun.stderr);
  });
  await t.test('unadopted-only selection', async () => {
    await writeFile(unadopted, "import test from 'node:test'; test('unadopted', () => {});");
    const unadoptedRun = spawnSync(process.execPath, [join(root, 'invoke.mjs'), unadopted],
      { cwd: root, encoding: 'utf8', env: childEnvironment });
    assert.equal(unadoptedRun.status, 0, unadoptedRun.stderr);
    assert.match(unadoptedRun.stdout, /unadopted/u);
  });
  await t.test('entry aliases cannot bypass mandatory identities', async () => {
    await writeContract();
    await writeFile(join(root, testFile), skipped);
    const adopted = join(root, testFile);
    const hardlink = join(root, 'alias.test.mjs');
    await link(adopted, hardlink);
    const aliased = spawnSync(process.execPath, [join(root, 'invoke.mjs'), hardlink],
      { cwd: root, encoding: 'utf8', env: childEnvironment });
    assert.equal(aliased.status, 1, aliased.stderr);
    assert.match(aliased.stderr, /selected file aliases an adopted entry/u);

    const caseAlias = join(root, 'CASES.TEST.MJS');
    const caseAliasStat = await stat(caseAlias, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') { return null; }
      throw error;
    });
    if (caseAliasStat !== null) {
      const adoptedStat = await stat(adopted, { bigint: true });
      if (caseAliasStat.dev === adoptedStat.dev && caseAliasStat.ino === adoptedStat.ino) {
        const caseVariant = spawnSync(process.execPath, [join(root, 'invoke.mjs'), caseAlias],
          { cwd: root, encoding: 'utf8', env: childEnvironment });
        assert.equal(caseVariant.status, 1, caseVariant.stderr);
        assert.match(caseVariant.stderr, /selected file aliases an adopted entry/u);
      }
    }

    const secondFile = 'second-required.test.mjs';
    await writeFile(contractPath, JSON.stringify(contract([required, identity(secondFile, ['second required'])])));
    await writeFile(adopted, passing);
    await writeFile(join(root, secondFile), "import test from 'node:test'; test.skip('second required', () => {});");
    const secondAlias = join(root, 'second-alias.test.mjs');
    await link(join(root, secondFile), secondAlias);
    const mixedAlias = spawnSync(process.execPath, [join(root, 'invoke.mjs'), testFile, secondAlias],
      { cwd: root, encoding: 'utf8', env: childEnvironment });
    assert.equal(mixedAlias.status, 1, mixedAlias.stderr);
    assert.match(mixedAlias.stderr, /selected file aliases an adopted entry/u);
  });
}));

// A real assertion must remain a failed verdict while retaining developer evidence.
test('mandatory runner retains assertion detail and fixture location while rejecting', async () => fixture(async (root) => {
  const source = `import assert from 'node:assert/strict';
import test from 'node:test';
test('controlled diagnostic failure', () => {
  assert.equal('EF382_ACTUAL', 'EF382_EXPECTED', 'EF382_ASSERTION_MARKER');
});
`;
  const result = await runFixture(root, source, [identity(testFile, ['controlled diagnostic failure'])]);
  const transport = JSON.stringify({ status: result.status, signal: result.signal,
    error: result.error?.code, stderr: result.stderr?.slice(0, 2048) });
  assert.equal(result.error, undefined, transport);
  assert.equal(result.signal, null, transport);
  assert.equal(result.status, 1, transport);
  assert.match(result.stderr, /Node test execution contract: failed/u, transport);
  assert.match(result.stdout, /FAIL controlled diagnostic failure/u);
  assert.match(result.stdout, /EF382_ASSERTION_MARKER/u);
  assert.match(result.stdout, /"actual":"EF382_ACTUAL"/u);
  assert.match(result.stdout, /"expected":"EF382_EXPECTED"/u);
  assert.ok(result.stdout.includes(`${testFile}:4:`), result.stdout);
}));

// Under the default process isolation, oversized values are the pathological input this test can
// reach. Proxy, getter and toJSON hostile values are not exercised here: each file runs in a child
// process and its events reach the parent through Node's event serialization, which is expected to
// prevent such objects arriving intact, but that boundary is unverified. The separate
// isolation 'none' regression below exercises hostile values; the isProxy guard is defense in depth.
// Bounding must keep the whole failure record, as complete valid JSON, within 8192 characters and
// bytes (QGR retains at most that much failure output) without erasing actual, expected,
// operator or the assertion location. Control characters (six escaped output characters per
// code unit) are the worst-case escaping input.
test('mandatory runner bounds oversized assertion evidence without erasing fields or location', async () => fixture(async (root) => {
  const required = [identity(testFile, ['oversized diagnostic failure'])];
  const assertionLevel = (stdout) => {
    const [header, json, ...rest] = stdout.split('\n');
    assert.equal(header, 'FAIL oversized diagnostic failure', stdout);
    assert.deepEqual(rest, [''], stdout);
    let level = JSON.parse(json);
    for (let depth = 0; depth < 3 && level?.actual === undefined; depth++) { level = level?.cause; }
    assert.equal(typeof level, 'object', json);
    assert.ok(Array.isArray(level.location), json);
    assert.ok(level.location[0].includes(`${testFile}:4:`), json);
    return level;
  };
  const run = async (assertion) => {
    const result = await runFixture(root, ["import assert from 'node:assert/strict';", "import test from 'node:test';",
      "test('oversized diagnostic failure', () => {", assertion, '});', ''].join('\n'), required);
    const transport = JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code,
      stdout: result.stdout?.slice(0, 2048), stderr: result.stderr?.slice(0, 2048) });
    assert.equal(result.error, undefined, transport);
    assert.equal(result.signal, null, transport);
    assert.equal(result.status, 1, transport);
    assert.match(result.stderr, /Node test execution contract: failed/u, transport);
    assert.match(result.stdout, /FAIL oversized diagnostic failure/u, transport);
    assert.ok(result.stdout.length <= 8192 && Buffer.byteLength(result.stdout) <= 8192,
      `unbounded diagnostic: ${result.stdout.length} characters`);
    return assertionLevel(result.stdout);
  };
  // The fixture throws an Error with own assertion fields, so Node formats no assertion diff.
  // 4096 units already exceed every field limit; the bound does not depend on input length.
  const assertionFields = "name: 'AssertionError', code: 'ERR_ASSERTION', operator: 'strictEqual'";
  const scalar = await run(`  const u = (c) => String.fromCharCode(c).repeat(4096); throw Object.assign(new Error('m'), { ${assertionFields}, message: 'EF382_MESSAGE_HEAD' + u(3), actual: 'EF382_ACTUAL_HEAD' + u(1), expected: 'EF382_EXPECTED_HEAD' + u(2) });`);
  assert.equal(scalar.operator, 'strictEqual');
  assert.ok(scalar.message.startsWith('EF382_MESSAGE_HEAD'), scalar.message);
  assert.ok(scalar.actual.startsWith('EF382_ACTUAL_HEAD'), scalar.actual);
  assert.ok(scalar.expected.startsWith('EF382_EXPECTED_HEAD'), scalar.expected);
  for (const truncated of [scalar.message, scalar.actual, scalar.expected]) {
    assert.match(truncated, /\.\.\.\[truncated \d+ chars\]$/u);
  }
  const array = await run("  throw Object.assign(new Error('m'), { name: 'AssertionError', code: 'ERR_ASSERTION', operator: 'deepStrictEqual', actual: Array.from({ length: 1000 }, (_, i) => `EF382_ITEM_${i}`), expected: ['EF382_EXPECTED_ITEM'] });");
  assert.equal(array.operator, 'deepStrictEqual');
  assert.equal(array.actual.type, 'array');
  assert.equal(array.actual.length, 1000);
  assert.equal(array.actual.omitted, 998);
  assert.deepEqual(array.actual.items, ['EF382_ITEM_0', 'EF382_ITEM_1']);
  assert.equal(array.expected.length, 1);
  assert.ok(array.expected.items[0].startsWith('EF382_EXPECT'), JSON.stringify(array.expected));
  // Backslash, quote, lone surrogate, U+2028, BEL and an astral character, all on the assertion line.
  const mixed = await run(`  const m = () => (String.fromCharCode(92, 34, 0xd800, 0x2028, 7) + String.fromCodePoint(0x1f600)).repeat(1024); throw Object.assign(new Error('m'), { ${assertionFields}, message: 'EF382_MESSAGE_HEAD' + m(), actual: 'EF382_ACTUAL_HEAD' + m(), expected: 'EF382_EXPECTED_HEAD' + m() });`);
  assert.equal(mixed.operator, 'strictEqual');
  assert.ok(mixed.actual.startsWith('EF382_ACTUAL_HEAD'), mixed.actual);
  assert.ok(mixed.expected.startsWith('EF382_EXPECTED_HEAD'), mixed.expected);
  assert.match(mixed.actual, /\.\.\.\[truncated \d+ chars\]$/u);
  // Long, individually oversized causes attached to the assertion error. Whether Node's event
  // serialization keeps them is not asserted; the record must stay bounded either way.
  const caused = await run(`  const cause = Array.from({ length: 6 }).reduce((inner, _, i) => new Error(\`EF382_CAUSE_\${i}\` + 'x'.repeat(4096), { cause: inner }), undefined); throw Object.assign(new Error('m'), { ${assertionFields}, message: 'EF382_MESSAGE_HEAD' + 'm'.repeat(4096), actual: 'EF382_ACTUAL_HEAD' + 'a'.repeat(4096), expected: 'EF382_EXPECTED_HEAD' + 'e'.repeat(4096), cause });`);
  assert.equal(caused.operator, 'strictEqual');
  assert.ok(caused.actual.startsWith('EF382_ACTUAL_HEAD'), caused.actual);
  assert.ok(caused.expected.startsWith('EF382_EXPECTED_HEAD'), caused.expected);
  // Non-string metadata must never inflate the scalar budgets: each field is a capped string or a marker.
  const malformed = await run("  throw Object.assign(new Error('m'), { name: Array.from({ length: 50 }, () => 'N'.repeat(100)), code: { nested: 'C'.repeat(5000) }, operator: ['O'.repeat(5000)], message: Array.from({ length: 50 }, () => 'M'.repeat(100)), actual: Array.from({ length: 1000 }, (_, i) => `EF382_ITEM_${i}`), expected: 'EF382_EXPECTED_HEAD' + 'e'.repeat(4096) });");
  for (const field of ['name', 'code', 'operator', 'message']) {
    assert.equal(typeof malformed[field], 'string', field);
    assert.ok(malformed[field].length <= 100, `${field}: ${malformed[field].length}`);
  }
  assert.equal(malformed.actual.type, 'array');
  assert.equal(malformed.actual.length, 1000);
  assert.ok(malformed.expected.startsWith('EF382_EXPECTED_HEAD'), malformed.expected);
}));

// Hostile failure values only reach the formatter without a process boundary, so this runs the real
// runner with isolation 'none'. That is a diagnostic-only fixture: isolation 'none' is neither
// qualified nor supported, because it emits no entryFile and the evaluator rejects the run with
// "unattributed test:enqueue event". The formatter still runs on each test:fail event while the
// events are collected, before the evaluator rejects, which is all this test relies on. Node's own pipeline may touch these values first (it builds the
// failure wrapper); the fixture therefore tags every trap or getter hit with whether a formatter
// function (failureDetail, nodeTestFailureDetail, boundedValue, ownData) is on the call stack.
// Only formatter-attributed hits are asserted to be absent; nothing is claimed about Node's own
// reads. Traps forward and never throw, so a reflecting formatter shows up as a recorded hit, not
// as a masked exception. The old eager Object.getOwnPropertyNames reflection records ownKeys and
// getOwnPropertyDescriptor hits on the Proxy cause and fails this test.
test('mandatory runner formatter reflects no hostile failure value under in-process isolation', async () => fixture(async (root) => {
  const names = ['hostile proxy failure', 'hostile accessor failure', 'hostile hook failure'];
  const source = String.raw`import { appendFileSync } from 'node:fs';
import test from 'node:test';
import { inspect } from 'node:util';
const hit = (what) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const stack = new Error('probe').stack;
  Error.stackTraceLimit = limit;
  const formatter = /\b(failureDetail|nodeTestFailureDetail|boundedValue|ownData)\b/u.test(stack);
  appendFileSync('hits.jsonl', JSON.stringify({ what, formatter }) + '\n');
};
test('hostile proxy failure', () => {
  const target = Object.assign(new Error('EF382_PROXY_TARGET'), { actual: 'a', expected: 'e', operator: 'strictEqual' });
  const handler = new Proxy({}, { get: (_, trap) => (...args) => { hit('proxy:' + String(trap)); return Reflect[trap](...args); } });
  throw new Proxy(target, handler);
});
test('hostile accessor failure', () => {
  const error = new Error('EF382_ACCESSOR_BASE');
  for (const key of ['name', 'code', 'operator', 'message', 'actual', 'expected', 'cause']) {
    Object.defineProperty(error, key, { get() { hit('getter:' + key); return 'x'; }, enumerable: true, configurable: true });
  }
  throw error;
});
test('hostile hook failure', () => {
  const hooks = () => ({ toJSON() { hit('toJSON'); return 'x'; }, [inspect.custom]() { hit('inspect'); return 'x'; } });
  throw Object.assign(new Error('EF382_HOOKS'), { operator: 'strictEqual', actual: hooks(), expected: [hooks()] });
});
`;
  const result = await runFixture(root, source, names.map((name) => identity(testFile, [name])), [], { isolation: 'none' });
  const transport = JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code,
    stdout: result.stdout?.slice(0, 4096), stderr: result.stderr?.slice(0, 2048) });
  assert.equal(result.error, undefined, transport);
  assert.equal(result.signal, null, transport);
  assert.equal(result.status, 1, transport);
  // isolation 'none' emits no entryFile, so the evaluator deterministically rejects the first event.
  assert.match(result.stderr, /Node test execution contract: unattributed test:enqueue event/u, transport);
  // Assert reflection first so an old formatter reports the recorded traps, not a marker mismatch.
  // The file must exist and hold Node-attributed hits, so an unreached fixture cannot pass vacuously.
  const hits = (await readFile(join(root, 'hits.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(hits.some((item) => !item.formatter), `no Node-attributed hit recorded: ${transport}`);
  const attributed = hits.filter((item) => item.formatter);
  assert.deepEqual(attributed, [], `formatter reflected hostile values; all hits: ${JSON.stringify(hits)}`);
  const lines = result.stdout.split('\n');
  for (const name of names) {
    const index = lines.indexOf(`FAIL ${name}`);
    assert.ok(index >= 0, `${name} lacks a FAIL record: ${transport}`);
    const record = lines[index + 1];
    assert.ok(record.length <= 8192, name);
    JSON.parse(record);
    if (name === 'hostile proxy failure') { assert.match(record, /\[proxy omitted\]/u, record); }
  }
}));
