import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse setup-node's pinned Nodes. pnpm/setup installs a self-contained executable,
// so fetch the exact declared JavaScript package separately for direct-Node tests.
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = JSON.parse(await readFile(join(workspace,
  'architecture/foundation/docs-protocol-current-policy.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, policy.runtime.productionDefault.qualificationVersion);
assert.ok(process.env.MANAGED_TEST_NODE26_SOURCE);
assert.ok(process.env.RUNNER_TEMP);
assert.ok(!/[\r\n]/u.test(process.env.RUNNER_TEMP));
assert.ok(process.env.GITHUB_ENV);
const source26 = await realpath(process.env.MANAGED_TEST_NODE26_SOURCE);
const versionMatch = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(manifest.packageManager);
assert.ok(versionMatch, 'packageManager must declare an exact pnpm version');
const pnpmVersion = versionMatch[1];

async function download(url, limit) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Public pnpm download failed: ${response.status}`);
  assert.ok(response.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= limit, 'Public pnpm download exceeds its byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const registry = 'https://registry.npmjs.org';
const metadata = JSON.parse(await download(`${registry}/pnpm/${pnpmVersion}`, 64 * 1024));
assert.equal(metadata.name, 'pnpm');
assert.equal(metadata.version, pnpmVersion);
const tarballUrl = `${registry}/pnpm/-/pnpm-${pnpmVersion}.tgz`;
assert.equal(metadata.dist.tarball, tarballUrl);
const archive = await download(tarballUrl, 20 * 1024 * 1024);
assert.equal(metadata.dist.integrity, `sha512-${createHash('sha512').update(archive).digest('base64')}`);

const tools = await mkdtemp(join(process.env.RUNNER_TEMP, 'managed-test-tools-'));
const env = { CI: 'true', LANG: 'C', HOME: tools };
const packageRoot = join(tools, 'pnpm/node_modules/pnpm');
await mkdir(packageRoot, { recursive: true });
const archivePath = join(tools, 'pnpm.tgz');
await writeFile(archivePath, archive);
const extraction = spawnSync('/usr/bin/tar', [
  '-xzf', archivePath, '-C', packageRoot, '--strip-components=1',
  '--no-same-owner', '--no-same-permissions'
], { env, cwd: tools, encoding: 'utf8', timeout: 30_000 });
assert.equal(extraction.error, undefined);
assert.equal(extraction.status, 0, extraction.stderr);
await unlink(archivePath);
const pnpmManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(pnpmManifest.name, 'pnpm');
assert.equal(manifest.packageManager, `pnpm@${pnpmManifest.version}`);
assert.equal(pnpmManifest.bin.pnpm, 'bin/pnpm.mjs');
assert.equal(await realpath(join(packageRoot, pnpmManifest.bin.pnpm)), join(packageRoot, pnpmManifest.bin.pnpm));

for (const [lane, source] of [['node24', process.execPath], ['node26', source26]]) {
  await mkdir(join(tools, lane, 'bin'), { recursive: true });
  await copyFile(source, join(tools, lane, 'bin/node'));
}
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
