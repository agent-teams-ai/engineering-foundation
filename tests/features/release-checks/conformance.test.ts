import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReleaseCandidate } from '../../../packages/release-checks/dist/index.js';
import { releaseCandidateConformanceCases } from '../../../packages/release-checks/dist/features/candidate-checking/conformance.js';

for (const entry of releaseCandidateConformanceCases) {
  void test(`release candidate public conformance: ${entry.id}`, () => {
    const before = JSON.stringify(entry.input);
    const result = checkReleaseCandidate(entry.input);
    assert.equal(result.outcome, entry.expected.outcome);
    assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), entry.expected.diagnosticCodes);
    assert.deepEqual(result.packageChanges, entry.expected.packageChanges);
    assert.equal(JSON.stringify(entry.input), before, 'checking must not mutate the accepted facts');
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.packageChanges));
    assert(Object.isFrozen(result.diagnostics));
  });
}

void test('common conformance data is immutable and contains independent expected release values', () => {
  assert(Object.isFrozen(releaseCandidateConformanceCases));
  const positive = releaseCandidateConformanceCases.find(entry => entry.id === 'direct-dependent-empty-and-unchanged-none');
  assert(positive);
  assert(Object.isFrozen(positive.input));
  assert.deepEqual(positive.expected.packageChanges.map(change => change.newVersion), ['1.1.0', '1.0.1']);
});
