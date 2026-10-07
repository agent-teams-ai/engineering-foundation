import assert from 'node:assert/strict';
import { createNodeManagedRuntimeScope } from '../dist/consumer-integration/adapters/node-managed-runtime.js';
import { validateSelection } from '../dist/consumer-integration/adapters/node-managed-runtime-identity.js';
import type {
  AttemptAcquisition,
  ManagedAttemptInput
} from '../dist/consumer-integration/application/ports/managed-runtime.js';
import type { PeerResult } from './managed-runtime-corrective-helpers.mts';

function requiredEnvironment(
  name: 'TEST_ROOT' | 'TEST_SELECTION' | 'TEST_EXTERNAL' | 'TEST_CONSUMER'
): string {
  const value = process.env[name];
  assert.ok(value, `Missing ${name}`);
  return value;
}

const candidate: unknown = JSON.parse(requiredEnvironment('TEST_SELECTION'));
const selection = validateSelection(candidate);
assert.ok(selection, 'TEST peer selection must satisfy the existing selection contract');
const signal = new AbortController().signal;
const scope = createNodeManagedRuntimeScope({
  privateRoot: requiredEnvironment('TEST_ROOT'),
  selection,
  signal
});

try {
  const admission = await scope.admit();
  assert.ok(admission.outcome === 'admitted', JSON.stringify(admission));
  const input: ManagedAttemptInput = {
    externalRoot: requiredEnvironment('TEST_EXTERNAL'),
    consumerRoot: requiredEnvironment('TEST_CONSUMER'),
    controllerBuildDigest: '1'.repeat(64),
    role: 'source',
    runtime: admission.runtime,
    signal
  };
  const result: AttemptAcquisition = await scope.acquireAttempt(input);
  const summary: PeerResult = result.outcome === 'refused'
    ? { outcome: 'refused', code: result.code }
    : { outcome: 'acquired' };
  process.stdout.write(JSON.stringify(summary) + '\n');
} finally {
  await scope.close();
}
