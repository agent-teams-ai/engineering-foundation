import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the pinned setup-node and pnpm/setup installations. No package downloads.
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = JSON.parse(await readFile(join(workspace,
  'architecture/foundation/docs-protocol-current-policy.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, policy.runtime.productionDefault.qualificationVersion);
assert.ok(process.env.MANAGED_TEST_NODE26_SOURCE);
assert.ok(process.env.PNPM_HOME);
assert.ok(process.env.RUNNER_TEMP);
assert.ok(process.env.GITHUB_ENV);
const source26 = await realpath(process.env.MANAGED_TEST_NODE26_SOURCE);
const pnpmEntry = await realpath(join(process.env.PNPM_HOME, 'pnpm'));
const pnpmRoot = dirname(dirname(pnpmEntry));
const pnpmManifest = JSON.parse(await readFile(join(pnpmRoot, 'package.json'), 'utf8'));
assert.equal(pnpmManifest.name, 'pnpm');
assert.equal(manifest.packageManager, `pnpm@${pnpmManifest.version}`);
assert.equal(pnpmManifest.bin.pnpm, 'bin/pnpm.mjs');
assert.equal(pnpmEntry, join(pnpmRoot, pnpmManifest.bin.pnpm));

const tools = await mkdtemp(join(process.env.RUNNER_TEMP, 'managed-test-tools-'));
for (const [lane, source] of [['node24', process.execPath], ['node26', source26]]) {
  await mkdir(join(tools, lane, 'bin'), { recursive: true });
  await copyFile(source, join(tools, lane, 'bin/node'));
}
const packageRoot = join(tools, 'pnpm/node_modules/pnpm');
await cp(pnpmRoot, packageRoot, { recursive: true, dereference: false });
const env = { CI: 'true', LANG: 'C', HOME: tools };
function requireVersion(node, args, version) {
  const result = spawnSync(node, args, { env, cwd: tools, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
}
for (const [lane, version] of [
  ['node24', policy.runtime.productionDefault.qualificationVersion],
  ['node26', policy.runtime.compatibilityLane.qualificationVersion]
]) {
  const node = join(tools, lane, 'bin/node');
  requireVersion(node, ['--version'], `v${version}`);
  requireVersion(node, [join(packageRoot, 'bin/pnpm.mjs'), '--version'], pnpmManifest.version);
}
const tests = await mkdtemp(join(process.env.RUNNER_TEMP, 'managed-test-cases-'));
await writeFile(join(tools, 'qualification.json'), `${JSON.stringify({
  node24: policy.runtime.productionDefault.qualificationVersion,
  node26: policy.runtime.compatibilityLane.qualificationVersion,
  pnpm: pnpmManifest.version, platform: process.platform, architecture: process.arch
}, null, 2)}\n`);
await appendFile(process.env.GITHUB_ENV,
  `MANAGED_TEST_TOOLS_ROOT=${tools}\nMANAGED_TEST_ROOT=${tests}\n`);
console.log('Qualified public pinned Node 24/26 and pnpm test copies.');
