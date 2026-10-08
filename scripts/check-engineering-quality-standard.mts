import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expected = Object.freeze({
  repository: 'agent-teams-ai/.github', path: 'docs/engineering-quality-standard.md',
  commit: '66d6d3d2c2643edac414ded48c0ee0586774dd07',
  blob: '705f14cd5048e24b7d61e1d8102b86395d7b014d',
  sha256: 'd55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8',
  size: 18080, identicalOperatorRevision: '05b30bcc00cdf07cfde9ba60a1136bb9df7f7571',
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

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkEngineeringQualityStandard(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write('Retained Engineering Quality Standard pin verified.\n');
}
