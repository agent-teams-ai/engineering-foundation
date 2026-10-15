import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expected = Object.freeze({
  repository: 'agent-teams-ai/.github', path: 'docs/engineering-quality-standard.md',
  commit: 'f9f4c8ad381254fb07cba737d6443542348395c1',
  blob: '705f14cd5048e24b7d61e1d8102b86395d7b014d',
  sha256: 'd55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8',
  size: 18080,
  historicalPins: Object.freeze([Object.freeze({
    commit: '66d6d3d2c2643edac414ded48c0ee0586774dd07',
    blob: '705f14cd5048e24b7d61e1d8102b86395d7b014d',
    sha256: 'd55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8',
    size: 18080,
    identicalOperatorRevision: '05b30bcc00cdf07cfde9ba60a1136bb9df7f7571'
  })]),
});

const expectedReview = Object.freeze({
  schemaVersion: 1,
  engineeringQualityStandard: Object.freeze({
    currentRevision: 'f9f4c8ad381254fb07cba737d6443542348395c1',
    currentSha256: 'd55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8',
    previousRevision: '66d6d3d2c2643edac414ded48c0ee0586774dd07',
    delta: 'bytes-identical'
  }),
  consumerModuleStandard: Object.freeze({
    currentRevision: '7d6535dd86533566620040233290869825000d2b',
    currentSha256: '859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a',
    sameBytesPreviousRevision: '5287ef4ebae3dce19feb9378a9a0ac9267b30878',
    retainedFoundationRevision: '81063add7de50ffe2b91cc74bf7271b298624c21',
    deltaFromRetained: 'reviewed-profile-completion-examples-property-contract-lint-codemod-namespace-tests-composition-root-evidence'
  }),
  classification: Object.freeze({
    featureModuleStandard: 'adopted-v1-through-ADR-0046',
    consumerModuleStandard: 'not-adopted',
    assembly: 'not-adopted',
    runtimeSeam: 'docs/architecture/runtime-profile-static-seam.md'
  })
});

const runtimeSeam = Object.freeze({
  tokens: Object.freeze([
    'Status: `not-adopted`; closed static selection only',
    '7d6535dd86533566620040233290869825000d2b',
    '20c281b3137f5d3c198250e9f8101c0ecd4cbc75',
    '5287ef4ebae3dce19feb9378a9a0ac9267b30878',
    '81063add7de50ffe2b91cc74bf7271b298624c21',
    'f9f4c8ad381254fb07cba737d6443542348395c1',
    '66d6d3d2c2643edac414ded48c0ee0586774dd07',
    '05b30bcc00cdf07cfde9ba60a1136bb9df7f7571',
    'does not use lifecycle-kernel and introduces no Assembly node',
  ]),
  paths: Object.freeze([
    'packages/engineering-foundation/src/process-execution/application/runtime-selection.ts',
    'packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/select-package-script-executor.ts',
    'packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/node-quality-gate-command.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/select-package-script-runner.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/node-commands.ts',
    'packages/engineering-foundation/src/process-execution/module.ts',
    'packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts',
    'packages/engineering-foundation/src/process-execution/node-process-runner.ts',
    'packages/engineering-foundation/src/process-execution/windows-managed-process.ts',
    'packages/engineering-foundation/src/process-execution/windows-managed-process-diagnostics.ts',
    'packages/engineering-foundation/src/process-execution/windows-process-host.ts',
  ]),
});

/** Retained upstream bytes are input evidence, never a consumer-owned policy. */
export async function checkEngineeringQualityStandard(root: string): Promise<void> {
  const prefix = resolve(root, 'standards/engineering-quality-standard');
  const provenance: unknown = JSON.parse(await readFile(`${prefix}.provenance.json`, 'utf8'));
  if (!isDeepStrictEqual(provenance, expected)) { throw new Error('EQS provenance does not match the reviewed pin'); }
  const review: unknown = JSON.parse(await readFile(resolve(root, 'standards/standards-pin-review.json'), 'utf8'));
  if (!isDeepStrictEqual(review, expectedReview)) {
    throw new Error('Standards pin review or consumer classification drifted');
  }
  const bytes = await readFile(`${prefix}.md`);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== expected.size || blob !== expected.blob
      || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('EQS retained bytes do not match the reviewed pin');
  }
  const seam = await readFile(resolve(root, 'docs/architecture/runtime-profile-static-seam.md'), 'utf8');
  if (runtimeSeam.tokens.some((token) => !seam.includes(token))) {
    throw new Error('Runtime profile seam does not retain the reviewed current and historical guidance records');
  }
  for (const path of runtimeSeam.paths) {
    const metadata = await stat(resolve(root, path)).catch(() => null);
    if (!seam.includes(path) || metadata?.isFile() !== true) {
      throw new Error(`Runtime profile seam path is missing or unclassified: ${path}`);
    }
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkEngineeringQualityStandard(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write('Retained Engineering Quality Standard and current runtime seam pins verified.\n');
}
