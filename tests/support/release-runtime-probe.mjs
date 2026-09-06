import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceCommit = '7095f55898da253ba81f6329f2b9ca27da712406';
const advancedCommit = 'b'.repeat(40);
Object.assign(process.env, { GITHUB_SHA: sourceCommit, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'fixture/release-probe' });
const originalSpawn = childProcess.spawnSync;
const { PUBLISHABLE_PACKAGES, PUBLISHABLE_PACKAGE_DEPENDENCIES } = await import(pathToFileURL(join(sourceRoot, 'scripts/publishable-packages.mjs')));
const { qualifiedArchive } = await import(pathToFileURL(join(sourceRoot, 'tests/pack-publishable-artifacts-support.mjs')));
const packages = PUBLISHABLE_PACKAGES.map(entry => ({ ...entry, ...JSON.parse(readFileSync(join(sourceRoot, entry.manifestPath))) }));
const versions = new Map(packages.map(info => [info.name, info.version]));
// This helper runs in a disposable child: all external effects are stubbed before
// importing the actual runtime. Real archive readers, tar, and release policy stay active.
const originalTimeout = globalThis.setTimeout;
// Preserve all 73 observations; accelerate only the inherited five-second delay.
globalThis.setTimeout = (callback, milliseconds, ...args) => originalTimeout(callback, milliseconds === 5000 ? 0 : milliseconds, ...args);
registerHooks({ resolve(specifier, context, next) {
  const fromRuntime = context.parentURL === pathToFileURL(join(sourceRoot, 'scripts/release-publish-ordered-runtime.mjs')).href;
  const stubs = {
    './pack-publishable-artifacts.mjs': 'export const packPublishableArtifacts = input => globalThis.releaseProbe.pack(input);',
    './github-release-reconciliation.mjs': `export const GITHUB_RECONCILIATION_ATTEMPTS = 1;
export const GITHUB_RECONCILIATION_RETRY_MILLISECONDS = 0;
export const githubJson = args => globalThis.releaseProbe.github(args);
export const reconcileGithubTagRelease = (...args) => globalThis.releaseProbe.reconcile(...args);`,
  };
  if (fromRuntime && Object.hasOwn(stubs, specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
} });

const ok = stdout => ({ status: 0, stdout, stderr: '' });

function begin(scenario) {
  const events = [];
  const archiveByName = new Map();
  const published = new Set();
  let liveMain = sourceCommit;
  let installed;
  const makeArchive = (info, destination) => {
    mkdirSync(destination, { recursive: true });
    const manifest = { name: info.name, version: info.version,
      dependencies: Object.fromEntries(PUBLISHABLE_PACKAGE_DEPENDENCIES[info.name].map(name => [name, versions.get(name)])) };
    const bytes = qualifiedArchive(manifest);
    const archivePath = join(destination, `${info.name.slice(1).replace('/', '-')}-${info.version}.tgz`);
    writeFileSync(archivePath, bytes, { mode: 0o444 });
    const archive = { archivePath, sha256: createHash('sha256').update(bytes).digest('hex'),
      packageName: info.name, packageVersion: info.version, manifest, bytes,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
    archiveByName.set(info.name, archive);
    return archive;
  };
  const statement = name => ({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: `pkg:npm/%40${name.slice(1)}@${versions.get(name)}`, digest: { sha512: createHash('sha512').update(archiveByName.get(name).bytes).digest('hex') } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { ref: 'refs/heads/main', repository: 'https://github.com/fixture/release-probe', path: '.github/workflows/release.yml' } },
      resolvedDependencies: [{ uri: 'git+https://github.com/fixture/release-probe@refs/heads/main', digest: { gitCommit: sourceCommit } }] } } });
  const bundle = name => ({ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: {
    payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement(name))).toString('base64') } } });
  globalThis.releaseProbe = {
    pack: async ({ temporaryRoot }) => {
      events.push({ operation: 'qualified-pack' });
      return Object.freeze(Object.fromEntries(packages.map(info => [info.name, Object.freeze(makeArchive(info, temporaryRoot))])));
    },
    github: args => {
      assert.match(args[0], /git\/ref\/heads\/main$/u);
      events.push({ operation: 'authorize', liveMain });
      const result = { object: { sha: liveMain, type: 'commit' }, ref: 'refs/heads/main' };
      if (scenario === 'advance-after-authorization' && liveMain === sourceCommit) {
        queueMicrotask(() => {
          liveMain = advancedCommit;
          events.push({ operation: 'main-advanced' });
        });
      }
      if (scenario === 'digest-mismatch' && !events.some(event => event.operation === 'archive-replaced')) {
        const archive = archiveByName.get(packages[0].name);
        unlinkSync(archive.archivePath);
        writeFileSync(archive.archivePath, 'changed qualified archive');
        events.push({ operation: 'archive-replaced' });
      }
      return result;
    },
    reconcile: () => { events.push({ operation: 'reconcile' }); },
  };
  childProcess.spawnSync = (command, args, options = {}) => {
    if (command === 'tar') { return originalSpawn(command, args, options); }
    if (command === 'git' && args[0] === 'merge-base') { return ok(''); }
    if (command === 'npm' && args[0] === '--version') { return ok('11.16.0\n'); }
    if (command === 'npm' && args[0] === 'publish') {
      const archive = [...archiveByName.values()].find(entry => entry.archivePath === args[1]);
      assert.ok(archive);
      assert.deepEqual(readFileSync(args[1]), archive.bytes);
      assert.ok(args.includes('--provenance') && args.includes('--ignore-scripts'));
      assert.equal(options.cwd, sourceRoot);
      events.push({ operation: 'publish-suppressed', name: archive.packageName, liveMain });
      published.add(archive.packageName);
      return ok('');
    }
    if (command === 'npm' && args[0] === 'install') {
      installed = packages.find(info => args.at(-1) === `${info.name}@${info.version}`)?.name;
      assert.ok(installed);
      return ok('');
    }
    if (command === 'npm' && args[0] === 'audit') { return ok(JSON.stringify({ invalid: [], missing: [], verified: [{
      name: installed, version: versions.get(installed), attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
      attestationBundles: [bundle(installed), { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1' }],
    }] })); }
    throw new Error(`Unexpected suppressed subprocess: ${command} ${args[0]}`);
  };
  syncBuiltinESMExports();
  globalThis.fetch = async raw => {
    const url = new URL(raw);
    assert.equal(url.hostname, 'registry.npmjs.org');
    const decoded = decodeURIComponent(url.pathname.slice(1));
    if (decoded.startsWith('fixture-tarball/')) {
      const name = decoded.slice('fixture-tarball/'.length);
      return { ok: true, arrayBuffer: async () => archiveByName.get(name).bytes };
    }
    if (decoded.startsWith('-/npm/v1/attestations/')) {
      const name = packages.find(info => decoded.endsWith(`${info.name}@${info.version}`))?.name;
      assert.ok(name);
      return { ok: true, json: async () => ({ attestations: [bundle(name)] }) };
    }
    const archive = archiveByName.get(decoded);
    assert.ok(archive, decoded);
    if (!published.has(decoded)) { return { status: 404, ok: false }; }
    return { status: 200, ok: true, json: async () => ({ versions: { [versions.get(decoded)]: {
      dist: { integrity: archive.integrity, tarball: `https://registry.npmjs.org/fixture-tarball/${encodeURIComponent(decoded)}` } } },
      time: { [versions.get(decoded)]: '2026-09-06T00:00:00Z' }, 'dist-tags': { latest: versions.get(decoded) } }) };
  };
  return events;
}

const scenario = process.argv[2];
assert.ok(['valid-wave', 'advance-after-authorization', 'digest-mismatch'].includes(scenario));
const events = begin(scenario);
const { publishOrderedRelease } = await import(pathToFileURL(join(sourceRoot, 'scripts/release-publish-ordered-runtime.mjs')));
let error;
try { await publishOrderedRelease({ cwd: sourceRoot, decision: { tag: 'latest' }, state: { packages: { public: packages } } }); }
catch (caught) { error = caught.message; }
const publications = events.filter(event => event.operation === 'publish-suppressed');
const reconciliations = events.filter(event => event.operation === 'reconcile');
if (scenario === 'valid-wave') {
  assert.equal(error, undefined);
  assert.equal(publications.length, 6);
  assert.equal(reconciliations.length, 6);
  assert.deepEqual(publications.map(item => item.name), PUBLISHABLE_PACKAGES.map(info => info.name));
  assert.ok(publications.every(item => item.liveMain === sourceCommit));
  assert.ok(events.lastIndexOf(publications.at(-1)) < events.indexOf(reconciliations[0]));
} else {
  // The policy catches callback errors and reconciles absence; its diagnostics
  // and retry latency are inherited and deliberately outside this regression.
  assert.equal(publications.length, 0, JSON.stringify(events));
  assert.equal(reconciliations.length, 0);
  assert.match(error, /registry result remained absent/u);
  assert.ok(events.some(event => event.operation === (scenario === 'digest-mismatch' ? 'archive-replaced' : 'main-advanced')));
}
process.stdout.write(JSON.stringify({ scenario, error, events }) + '\n');
