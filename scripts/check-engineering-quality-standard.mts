import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expected = Object.freeze({
  repository: 'agent-teams-ai/.github', path: 'docs/engineering-quality-standard.md',
  commit: 'f5653f5630057524a4ee44e50c16e138442a9b42',
  blob: '86b82be3e5bd212e7d78e50d92349e323026347e',
  sha256: 'a65fb5150837b010a71abe36cefd26c32709eb9b9e89f3938498a647e72f5587',
  size: 18134,
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
    'uses lifecycle-kernel or introduces an Assembly node',
  ]),
  paths: Object.freeze([
    'packages/engineering-foundation/src/process-execution/application/runtime-selection.ts',
    'packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/select-package-script-executor.ts',
    'packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/node-quality-gate-command.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/select-package-script-runner.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/node-commands.ts',
    'packages/engineering-foundation/src/process-execution/node-process-runner.ts',
  ]),
});

/** Retained upstream bytes are input evidence, never a consumer-owned policy. */
export async function checkEngineeringQualityStandard(root: string): Promise<void> {
  const prefix = resolve(root, 'standards/engineering-quality-standard');
  const provenance: unknown = JSON.parse(await readFile(`${prefix}.provenance.json`, 'utf8'));
  if (!isDeepStrictEqual(provenance, expected)) { throw new Error('EQS provenance does not match the reviewed pin'); }
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
    if (!seam.includes(path) || (await stat(resolve(root, path))).isFile() === false) {
      throw new Error(`Runtime profile seam path is missing or unclassified: ${path}`);
    }
  }
}

const entry = process.argv.at(1);
const invoked = entry === undefined ? undefined : pathToFileURL(resolve(entry)).href;
if (invoked === import.meta.url) {
  await checkEngineeringQualityStandard(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write('Retained Engineering Quality Standard and current runtime seam pins verified.\n');
}
