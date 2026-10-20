import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertReleaseExecutionCustody, checkFrozenVersionCandidate, checkReleaseCandidateRevisions,
  checkWorkingReleaseCandidate, freezeReleaseCandidate, hasReleaseVersionChanges,
  readReleaseCandidateContext, removeReleaseCandidateContext, shouldRunChangesetsAction,
  writeReleaseCandidateContext, type FrozenReleaseCandidate,
} from '../scripts/release-candidate-host.ts';
import { observeChangesetsInstallation, releaseObject } from '../scripts/release-candidate-observation.ts';

const execute = promisify(execFile);
const packageName = '@agent-teams/engineering-foundation';
const manifestPath = 'packages/engineering-foundation/package.json';
const require = createRequire(import.meta.url);

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}
async function json(root: string, path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}
async function fixture(options: { readonly empty?: boolean; readonly ignored?: boolean; readonly noIntent?: boolean; readonly prerelease?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'foundation-release-host-TEST-'));
  await json(root, 'package.json', { name: 'foundation-release-host-TEST', private: true, version: '0.0.0',
    workspaces: ['packages/*', 'spikes/*'] });
  await json(root, manifestPath, { name: packageName, version: options.prerelease === true ? '1.0.1-rc.0' : '1.0.0' });
  await json(root, 'spikes/private/package.json', { name: '@qualification/private', private: true, version: '0.0.0' });
  await json(root, '.changeset/config.json', { changelog: '@changesets/cli/changelog', commit: false, fixed: [],
    access: 'public', baseBranch: 'main', updateInternalDependencies: 'patch',
    ignore: options.ignored === true ? [packageName] : [], privatePackages: { version: true, tag: false } });
  await writeFile(join(root, 'packages/engineering-foundation/CHANGELOG.md'), `# ${packageName}\n\n## 1.0.0\n\nRetained history.\n`);
  await writeFile(join(root, 'source.ts'), 'export const unchanged = true;\n');
  if (options.noIntent !== true) {
    await writeFile(join(root, '.changeset/release.md'), options.empty === true ? '---\n---\n\nEmpty housekeeping.\n'
      : `---\n"${packageName}": patch\n---\n\nActual Changesets release.\n`);
  }
  if (options.prerelease === true) {
    await json(root, '.changeset/pre.json', { mode: 'pre', tag: 'rc', initialVersions: { [packageName]: '1.0.0', '@qualification/private': '0.0.0' }, changesets: [] });
  }
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'user.name', 'iliya');
  await git(root, 'config', 'user.email', 'iliyazelenkog@gmail.com');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'test: accepted release inputs');
  return { root, sourceSha: await git(root, 'rev-parse', 'HEAD') };
}
async function version(candidate: FrozenReleaseCandidate): Promise<void> {
  await execute(candidate.custody.installation.nodeExecutable, [candidate.custody.installation.entrypoint, 'version'],
    { cwd: candidate.custody.sourceRoot, encoding: 'utf8' });
}

void test('real engine output is checked before baseline writes and independently at PR head/base', async () => {
  const { root, sourceSha } = await fixture();
  const environment = { ...process.env };
  let context: Awaited<ReturnType<typeof writeReleaseCandidateContext>> | undefined;
  try {
    const candidate = await freezeReleaseCandidate(root);
    assert.equal(candidate.custody.installation.version, '2.31.1');
    assert.equal(candidate.expected.packages.length, 3);
    assert.equal(candidate.expected.packages.find(pkg => pkg.root === '.')?.classification, 'private');
    assert.equal(hasReleaseVersionChanges(candidate), true);
    context = await writeReleaseCandidateContext(candidate);
    Object.assign(process.env, context.environment);
    await version(candidate);
    const generated = await checkFrozenVersionCandidate(root);
    assert.equal(generated.report.outcome, 'passed');
    assert.deepEqual(generated.report.packageChanges, [{ packageName, manifestPath, oldVersion: '1.0.0', newVersion: '1.0.1' }]);
    const manifest = await readFile(join(root, manifestPath), 'utf8');
    await json(root, manifestPath, { ...JSON.parse(manifest) as object, scripts: { prepublishOnly: 'unexpected-command' } });
    let baselineWrites = 0;
    await assert.rejects(async () => { await checkFrozenVersionCandidate(root); baselineWrites += 1; }, /manifest.content-changed/u);
    assert.equal(baselineWrites, 0);
    await writeFile(join(root, manifestPath), manifest);
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: actual generated candidate');
    const head = await git(root, 'rev-parse', 'HEAD');
    const qualified = await checkReleaseCandidateRevisions(root, sourceSha, head);
    assert.equal(qualified.report.outcome, 'passed');
    assert.deepEqual(qualified.expected.binding, generated.expected.binding, 'accepted source bindings survive the independent base checkout');
    assert.equal(qualified.observed.binding.source.identity, sourceSha);
    assert.equal((await git(root, 'worktree', 'list', '--porcelain')).match(/^worktree /gmu)?.length, 1);
    await json(root, manifestPath, { ...JSON.parse(manifest) as object, exports: { '.': './unexpected.js' } });
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: candidate tampering after generation');
    await assert.rejects(checkReleaseCandidateRevisions(root, sourceSha, await git(root, 'rev-parse', 'HEAD')), /manifest.content-changed/u);
    assert.equal((await git(root, 'worktree', 'list', '--porcelain')).match(/^worktree /gmu)?.length, 1);
  } finally {
    if (context !== undefined) { await removeReleaseCandidateContext(context.environment); }
    for (const name of Object.keys(process.env)) { if (!(name in environment)) { delete process.env[name]; } }
    Object.assign(process.env, environment);
    await rm(root, { recursive: true, force: true });
  }
});

void test('complete observation rejects hidden private/root content, source, version, modes and untracked output', async () => {
  const { root } = await fixture();
  try {
    const candidate = await freezeReleaseCandidate(root); await version(candidate);
    for (const [path, mutation] of [
      ['package.json', (value: Record<string, unknown>) => ({ ...value, scripts: { hidden: 'command' } })],
      ['spikes/private/package.json', (value: Record<string, unknown>) => ({ ...value, version: '0.0.1' })],
      [manifestPath, (value: Record<string, unknown>) => ({ ...value, version: '1.0.2' })],
      [manifestPath, (value: Record<string, unknown>) => ({ ...value, dependencies: { injected: '1.0.0' } })],
    ] as const) {
      const before = await readFile(join(root, path), 'utf8');
      await json(root, path, mutation(JSON.parse(before) as Record<string, unknown>));
      await assert.rejects(checkWorkingReleaseCandidate(candidate), /manifest.content-changed|plan.unexpected-version|plan.version-mismatch/u);
      await writeFile(join(root, path), before);
    }
    await git(root, 'update-index', '--assume-unchanged', 'source.ts');
    await writeFile(join(root, 'source.ts'), 'export const injected = true;\n');
    await assert.rejects(checkWorkingReleaseCandidate(candidate), /diff.unexpected/u);
    await writeFile(join(root, 'source.ts'), 'export const unchanged = true;\n');
    await git(root, 'update-index', '--no-assume-unchanged', 'source.ts');
    await writeFile(join(root, 'untracked-output.json'), '{}\n');
    await assert.rejects(checkWorkingReleaseCandidate(candidate), /Untracked release outputs/u);
    await rm(join(root, 'untracked-output.json'));
    if (process.platform !== 'win32') {
      await chmod(join(root, manifestPath), 0o755);
      await assert.rejects(checkWorkingReleaseCandidate(candidate), /nonexecutable release input/u);
      await chmod(join(root, manifestPath), 0o644);
    }
    const restored = await checkWorkingReleaseCandidate(candidate);
    assert.equal(restored.report.outcome, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('no-release plans preserve ignored and empty intents without version execution or PR waiting', async () => {
  for (const options of [{ empty: true }, { ignored: true }, { noIntent: true }]) {
    const { root } = await fixture(options);
    try {
      const candidate = await freezeReleaseCandidate(root);
      assert.equal(hasReleaseVersionChanges(candidate), false);
      assert.equal(shouldRunChangesetsAction(candidate), 'noIntent' in options);
      assert.equal((await checkWorkingReleaseCandidate(candidate)).report.outcome, 'passed');
      assert.equal(await git(root, 'status', '--porcelain'), '');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

void test('pinned v2 filename rules preserve ignored documents and actual dotted or AGENTS intents', async () => {
  const documents = ['README.md', 'readme.md', 'ReadMe.md', '.hidden.md', 'notes.MD'];
  for (const noIntent of [false, true]) {
    const { root } = await fixture({ noIntent });
    try {
      for (const name of documents) { await writeFile(join(root, '.changeset', name), `# Retained ${name}\n`); }
      if (!noIntent) {
        await git(root, 'mv', '.changeset/release.md', '.changeset/release.note.md');
        await writeFile(join(root, '.changeset/AGENTS.md'), `---\n"${packageName}": patch\n---\n\nV2 treats this name as an intent.\n`);
      }
      await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: accepted pinned-reader filenames');
      const candidate = await freezeReleaseCandidate(root);
      const expectedIds = noIntent ? [] : ['AGENTS', 'release.note'];
      assert.deepEqual(candidate.expected.intents.map(intent => intent.id), expectedIds);
      assert.deepEqual(candidate.officialPlan.changesets.map(intent => intent.id).toSorted(), expectedIds);
      assert.equal(hasReleaseVersionChanges(candidate), !noIntent);
      if (!noIntent) { await version(candidate); }
      assert.equal((await checkWorkingReleaseCandidate(candidate)).report.outcome, 'passed');
      for (const name of documents) {
        const path = join(root, '.changeset', name); const before = await readFile(path);
        await writeFile(path, '# Unexpected documentation rewrite\n');
        await assert.rejects(checkWorkingReleaseCandidate(candidate), /diff.unexpected/u);
        await writeFile(path, before);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

void test('existing prerelease intent recording uses actual retained source and metadata', async () => {
  const { root } = await fixture({ prerelease: true });
  try {
    const candidate = await freezeReleaseCandidate(root); await version(candidate);
    const qualified = await checkWorkingReleaseCandidate(candidate);
    assert.deepEqual(qualified.observed.consumptions, [{ intentId: 'release', digest: candidate.expected.intents[0].digest,
      effect: { kind: 'record', evidencePath: '.changeset/pre.json' } }]);
    assert.ok((await readFile(join(root, '.changeset/release.md'), 'utf8')).includes('Actual Changesets release.'));
    const prePath = join(root, '.changeset/pre.json');
    const pre = releaseObject(await readFile(prePath), 'TEST prerelease state');
    assert.ok(Array.isArray(pre['changesets']));
    pre['changesets'].push('unobserved-intent');
    await writeFile(prePath, `${JSON.stringify(pre, null, 2)}\n`);
    await assert.rejects(checkWorkingReleaseCandidate(candidate), /unknown source intent/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('execution custody rejects changed processed HEAD, config, context and installed CLI bytes', async () => {
  const { root } = await fixture();
  const toolRoot = await mkdtemp(join(tmpdir(), 'foundation-release-cli-TEST-'));
  let context: Awaited<ReturnType<typeof writeReleaseCandidateContext>> | undefined;
  try {
    const originalCliRoot = dirname(require.resolve('@changesets/cli/package.json'));
    const cliRoot = join(toolRoot, 'cli');
    await cp(originalCliRoot, cliRoot, { recursive: true, filter: path => !path.slice(originalCliRoot.length + 1).split(/[\\/]/u).includes('node_modules') });
    await symlink(dirname(dirname(originalCliRoot)), join(toolRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const issuer = createRequire(join(originalCliRoot, 'package.json'));
    const declarations = releaseObject(await readFile(join(originalCliRoot, 'package.json')), 'TEST CLI')['dependencies'];
    assert.ok(declarations !== null && typeof declarations === 'object' && !Array.isArray(declarations));
    for (const name of Object.keys(declarations)) {
      const installedRoot = issuer.resolve.paths(name)?.map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')));
      assert.ok(installedRoot !== undefined, `Installed TEST CLI dependency is missing: ${name}`);
      const target = join(cliRoot, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(installedRoot), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (process.platform !== 'win32') { await chmod(join(cliRoot, 'bin.js'), 0o644); }
    const candidate = await freezeReleaseCandidate(root, { cliEntrypoint: join(cliRoot, 'bin.js') });
    const configBytes = await readFile(join(root, '.changeset/config.json'));
    const originalInstallation = await observeChangesetsInstallation(releaseObject(configBytes, 'TEST config'));
    assert.equal(candidate.custody.installation.digest, originalInstallation.digest, 'portable engine identity excludes checkout paths and filesystem execute bits');
    assert.notEqual(candidate.custody.installation.custodyDigest, originalInstallation.custodyDigest);
    context = await writeReleaseCandidateContext(candidate);
    assert.deepEqual(await readReleaseCandidateContext(context.environment), candidate);
    await writeFile(context.path, '{}\n');
    await assert.rejects(readReleaseCandidateContext(context.environment), /frozen context bytes changed/u);
    const configPath = join(root, '.changeset/config.json'); const config = await readFile(configPath);
    await writeFile(configPath, `${config.toString('utf8')}\n`);
    await assert.rejects(assertReleaseExecutionCustody(candidate), /execution installation changed/u);
    await writeFile(configPath, config);
    const bin = join(cliRoot, 'bin.js'); const binBytes = await readFile(bin);
    await writeFile(bin, `${binBytes.toString('utf8')}\n// substituted installed CLI bytes\n`);
    await assert.rejects(assertReleaseExecutionCustody(candidate), /execution installation changed/u);
    await writeFile(bin, binBytes);
    await git(root, 'commit', '--allow-empty', '-m', 'test: changed processed source');
    await assert.rejects(assertReleaseExecutionCustody(candidate), /execution installation changed/u);
  } finally {
    if (context !== undefined) { await removeReleaseCandidateContext(context.environment); }
    await rm(toolRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});
