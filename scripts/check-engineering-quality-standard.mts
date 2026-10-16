import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
}

const entry = process.argv.at(1);
const invoked = entry === undefined ? undefined : pathToFileURL(resolve(entry)).href;
if (invoked === import.meta.url) {
  await checkEngineeringQualityStandard(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write('Retained Engineering Quality Standard pin verified.\n');
}
