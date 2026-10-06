import type { RuntimeTuple } from '../dist/consumer-integration/application/ports/managed-runtime.js';
import type { TrustedRuntimeSelection } from '../dist/consumer-integration/adapters/node-managed-runtime-identity.js';

/** Declaration of the supplied, unchanged managed-runtime-fixtures.mjs exports. */
export interface FixtureRuntimeTuple extends RuntimeTuple {
  nodeVersion: '24.21.0' | '26.10.0';
  pnpmVersion: '11.20.0';
  platform: 'linux';
  architecture: 'x64';
}

export interface ManagedRuntimeFixture {
  root: string;
  node: string;
  packageRoot: string;
  expected: FixtureRuntimeTuple;
  selection: TrustedRuntimeSelection;
  trusted: {
    nodeSha: string;
    manifestSha: string;
    entrySha: string;
    treeSha: string;
  };
  cleanup(): Promise<void>;
}

export const workspace: string;
export const parent: string;
export function fixture(nodeLane: string): Promise<ManagedRuntimeFixture>;
export function negativePackageSelection(
  f: Pick<ManagedRuntimeFixture, 'selection' | 'packageRoot'>
): Promise<TrustedRuntimeSelection>;
