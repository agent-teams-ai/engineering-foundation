import { resolve } from 'node:path';
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

