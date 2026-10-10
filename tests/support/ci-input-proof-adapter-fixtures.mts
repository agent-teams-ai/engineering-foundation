import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { FoundationPilotRequest, Observation, ScopeCategory } from '../../scripts/ci-input-proof-foundation-adapter.mts';
import type { InputLeaf } from '../../packages/ci-input-proof/dist/index.js';

export const scopeCategories: readonly ScopeCategory[] = [
  'source', 'helpers', 'fixtures', 'config', 'lock', 'toolchain', 'installedGraph',
];
export const adapterLeaf = (category: ScopeCategory, content = '1'.repeat(64), membership: 'closed' | 'structural' = 'closed'): InputLeaf =>
  ({ path: `${category}/input.ts`, type: 'file', mode: '100644', membership, content });
export const adapterObservation = (
  boundaryId: string,
  inputs: readonly InputLeaf[] = scopeCategories.map(category => adapterLeaf(category)),
  scope: Readonly<Record<ScopeCategory, readonly string[]>> = Object.freeze({
    source: Object.freeze(['source/input.ts']),
    helpers: Object.freeze(['helpers/input.ts']),
    fixtures: Object.freeze(['fixtures/input.ts']),
    config: Object.freeze(['config/input.ts']),
    lock: Object.freeze(['lock/input.ts']),
    toolchain: Object.freeze(['toolchain/input.ts']),
    installedGraph: Object.freeze(['installedGraph/input.ts']),
  }),
): Observation => Object.freeze({
  schemaVersion: 1,
  boundaryId,
  scopeId: 'foundation.ci-input-proof.focus.v1',
  scope,
  inventory: Object.freeze({ version: 1, digestScheme: 'sha256', inputs }),
});
export const adapterRequest = (
  current: Observation,
  fullArgs: readonly string[] = ['-e', 'process.stdout.write("FULL-PASS")'],
): FoundationPilotRequest => Object.freeze({
  schemaVersion: 1,
  pilotId: 'foundation.ci-input-proof.focus.v1',
  tuple: Object.freeze({
    headSha: '1'.repeat(40),
    baseSha: '2'.repeat(40),
    mergeTuple: 'refs/heads/TEST-ci-input-proof',
  }),
  before: adapterObservation('before'),
  current,
  permittedContentChanges: Object.freeze([]),
  full: Object.freeze({
    command: process.execPath,
    args: fullArgs,
    cwd: resolve(process.cwd()),
    timeoutMs: 30_000,
  }),
});


const execFileAsync = promisify(execFile);
const boundedProcess = Object.freeze({ timeout: 30_000, maxBuffer: 1_048_576 });

export const readOptionalText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export async function copyCollectorFixture(sourceRoot: string, destinationRoot: string): Promise<void> {
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    filter: sourcePath => {
      const relativePath = relative(sourceRoot, sourcePath);
      return !relativePath.split(/[\\/]/u).some(
        part => ['.cache', '.git', 'node_modules'].includes(part),
      );
    },
  });
  await mkdir(join(destinationRoot, 'node_modules', '.pnpm'), { recursive: true });
  await copyFile(
    join(sourceRoot, 'node_modules', '.package-map.json'),
    join(destinationRoot, 'node_modules', '.package-map.json'),
  );
  await copyFile(
    join(sourceRoot, 'node_modules', '.pnpm', 'lock.yaml'),
    join(destinationRoot, 'node_modules', '.pnpm', 'lock.yaml'),
  );
}

async function writeReplacementRaceDriver(temporaryRoot: string): Promise<Readonly<{ preload: string; driver: string }>> {
  const preload = resolve(temporaryRoot, 'input-proof-replacement-race.preload.mts');
  const driver = resolve(temporaryRoot, 'input-proof-replacement-race.driver.mts');
  await Promise.all([
    writeFile(preload, [
      'import { renameSync, writeFileSync } from "node:fs";',
      'import { createRequire, syncBuiltinESMExports } from "node:module";',
      'const require = createRequire(import.meta.url);',
      'const fs = require("node:fs/promises");',
      'const target = process.env.CI_INPUT_PROOF_RACE_TARGET;',
      'const replacement = process.env.CI_INPUT_PROOF_RACE_REPLACEMENT;',
      'const marker = process.env.CI_INPUT_PROOF_RACE_MARKER;',
      'const kind = process.env.CI_INPUT_PROOF_RACE_KIND;',
      'const original = { lstat: fs.lstat, open: fs.open, readFile: fs.readFile };',
      'let swapped = false;',
      'const swap = () => {',
      '  if (swapped) return;',
      '  renameSync(replacement, target);',
      '  writeFileSync(marker, `swapped:${kind}`);',
      '  swapped = true;',
      '};',
      'fs.lstat = async function(path, ...args) {',
      '  const stat = await original.lstat.call(fs, path, ...args);',
      '  if (kind === "fifo" && path === target) swap();',
      '  return stat;',
      '};',
      'fs.readFile = async function(path, ...args) {',
      '  if (kind === "regular" && path === target) swap();',
      '  return original.readFile.call(fs, path, ...args);',
      '};',
      'fs.open = async function(path, ...args) {',
      '  const handle = await original.open.call(fs, path, ...args);',
      '  if (kind === "regular" && path === target) swap();',
      '  return handle;',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'), 'utf8'),
    writeFile(driver, [
      'import { resolve } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'const repositoryRoot = process.env.CI_INPUT_PROOF_REPOSITORY_ROOT;',
      'const collector = await import(pathToFileURL(resolve(repositoryRoot, "scripts/ci-input-proof-foundation-pilot.mts")).href);',
      'await collector.collectFoundationPilotObservation(repositoryRoot, "replacement-race");',
      'process.stdout.write("collected\\n");',
    ].join('\n'), 'utf8'),
  ]);
  return Object.freeze({ preload, driver });
}

export async function assertCollectorReplacementRejection(temporaryRoot: string, raceTarget: string): Promise<void> {
  const raceReplacement = resolve(temporaryRoot, 'packages', 'ci-input-proof', 'LICENSE.race-actual');
  const raceMarker = resolve(temporaryRoot, 'replacement-race-marker');
  const replacementContent = 'replacement actual file with different bytes\n';
  const raceDriver = await writeReplacementRaceDriver(temporaryRoot);
  const raceEnvironment = Object.freeze({
    ...process.env,
    CI_INPUT_PROOF_REPOSITORY_ROOT: temporaryRoot,
    CI_INPUT_PROOF_RACE_TARGET: raceTarget,
    CI_INPUT_PROOF_RACE_REPLACEMENT: raceReplacement,
    CI_INPUT_PROOF_RACE_MARKER: raceMarker,
  });
  await writeFile(raceReplacement, replacementContent, 'utf8');
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--import',
      pathToFileURL(raceDriver.preload).href,
      raceDriver.driver,
    ], {
      ...boundedProcess,
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: { ...raceEnvironment, CI_INPUT_PROOF_RACE_KIND: 'regular' },
    }),
    (error: unknown) => {
      const childError = error as NodeJS.ErrnoException & { stdout: string; stderr: string };
      assert.equal(childError.code, 1);
      assert.equal(childError.stdout, '');
      assert.match(childError.stderr, /uncertain input identity or content packages\/ci-input-proof\/LICENSE/u);
      return true;
    },
  );
  assert.equal(await readFile(raceMarker, 'utf8'), 'swapped:regular');
  assert.equal(await readFile(raceTarget, 'utf8'), replacementContent);
  await assert.rejects(readFile(raceReplacement, 'utf8'), { code: 'ENOENT' });

  if (process.platform === 'linux') {
    const fifoReplacement = resolve(temporaryRoot, 'packages', 'ci-input-proof', 'LICENSE.race-fifo');
    await execFileAsync('mkfifo', [fifoReplacement], {
      cwd: temporaryRoot,
      timeout: 5_000,
      maxBuffer: 65_536,
    });
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        pathToFileURL(raceDriver.preload).href,
        raceDriver.driver,
      ], {
        ...boundedProcess,
        cwd: temporaryRoot,
        encoding: 'utf8',
        env: { ...raceEnvironment, CI_INPUT_PROOF_RACE_REPLACEMENT: fifoReplacement, CI_INPUT_PROOF_RACE_KIND: 'fifo' },
      }),
      (error: unknown) => {
        const childError = error as NodeJS.ErrnoException & { stdout: string; stderr: string };
        assert.equal(childError.code, 1);
        assert.equal(childError.stdout, '');
        assert.match(childError.stderr, /scope input is not a file or symlink packages\/ci-input-proof\/LICENSE/u);
        return true;
      },
    );
    assert.equal(await readFile(raceMarker, 'utf8'), 'swapped:fifo');
  }
}
