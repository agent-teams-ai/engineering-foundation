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

const cmsPrefix = 'docs/architecture/evidence/runtime-profile-guidance-20261020/common-assembly';
const cmsExpected = Object.freeze({
  repository: 'agent-teams-ai/get-modular', path: 'docs/architecture/common-assembly.md',
  anchor: 'consumer-module-standard', commit: '300e7e1c459c08f5e271627e4ca7d2486bdf5e1f',
  blob: 'ae6792543bd19acc948e177e8d55632c9d51134e',
  sha256: 'c2fe582a14ff6e79620b232ca7ffc914afb0474ec21fd43f208251dd7252f4a3',
  size: 81436,
});

const runtimeSeam = Object.freeze({
  currentPins: Object.freeze({
    'CMS guidance commit': cmsExpected.commit,
    'CMS guidance SHA-256': cmsExpected.sha256,
    'EQS guidance commit': expected.commit,
    'EQS guidance SHA-256': expected.sha256,
    'Workflow boundary': 'existing-static-adapter',
    'Workflow owner': 'engineering-foundation/repository-agent-workflow',
    'Workflow lifecycle': 'Host custody and cleanup; no Assembly or lifecycle-kernel adoption',
  }),
  tokens: Object.freeze([
    'Status: `not-adopted`; closed static selection only',
    '3dd68a6b26f42159714a4640b613534a55c2c6aa',
    'e5cb510c5ea83e54a6833cc40b6ad31fc5cf8c70d9838e4e0c6923edc6f70919',
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
    'packages/engineering-foundation/src/process-execution/windows-command-launch.ts',
    'packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/inbound/cli/check-changed-command.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/application/ports/check-changed.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/filesystem/mutable-check-input-custody.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/pnpm/mutable-pnpm-check-runner.ts',
    'packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/pnpm/qualified-pnpm-check-runner.ts',
  ]),
});

async function checkRetainedPin(
  prefix: string,
  pin: Readonly<{ blob: string; sha256: string; size: number }>,
  label: 'EQS' | 'CMS',
  extension: '.md' | '.txt' = '.md',
): Promise<void> {
  const provenance: unknown = JSON.parse(await readFile(`${prefix}.provenance.json`, 'utf8'));
  if (!isDeepStrictEqual(provenance, pin)) { throw new Error(`${label} provenance does not match the reviewed pin`); }
  const bytes = await readFile(`${prefix}${extension}`);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== pin.size || blob !== pin.blob
      || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error(`${label} retained bytes do not match the reviewed pin`);
  }
}

/** Retained upstream bytes are input evidence, never a consumer-owned policy. */
export async function checkEngineeringQualityStandard(root: string): Promise<void> {
  await checkRetainedPin(resolve(root, 'standards/engineering-quality-standard'), expected, 'EQS');
  await checkRetainedPin(resolve(root, cmsPrefix), cmsExpected, 'CMS', '.txt');
  const delta = await readFile(resolve(root, `${cmsPrefix}.diff`));
  if (createHash('sha256').update(delta).digest('hex') !==
      '65b7b1e9d0cc45836fc188ef332ffcc8c35227df6045ef1acde0e8f6b9346af5') {
    throw new Error('CMS retained delta does not match the reviewed input');
  }
  const seam = await readFile(resolve(root, 'docs/architecture/runtime-profile-static-seam.md'), 'utf8');
  for (const [label, pin] of Object.entries(runtimeSeam.currentPins)) {
    const records = seam.split(/\r?\n/u).filter((line) => line.startsWith(`${label}:`));
    if (records.length !== 1 || records[0] !== `${label}: \`${pin}\``) {
      throw new Error(`Runtime profile seam current guidance does not match the reviewed pin: ${label}`);
    }
  }
  if (runtimeSeam.tokens.some((token) => !seam.includes(token))) {
    throw new Error('Runtime profile seam does not retain the reviewed current and historical guidance records');
  }
  for (const path of runtimeSeam.paths) {
    const isFile = await stat(resolve(root, path)).then((info) => info.isFile(), () => false);
    if (!seam.includes(path) || !isFile) {
      throw new Error(`Runtime profile seam path is missing or unclassified: ${path}`);
    }
  }
}

const entry = process.argv.at(1);
const invoked = entry === undefined ? undefined : pathToFileURL(resolve(entry)).href;
if (invoked === import.meta.url) {
  await checkEngineeringQualityStandard(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write('Retained EQS/CMS inputs and reviewed runtime seam guidance pins verified.\n');
}
