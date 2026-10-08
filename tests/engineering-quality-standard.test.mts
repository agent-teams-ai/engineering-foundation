import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkEngineeringQualityStandard } from '../scripts/check-engineering-quality-standard.mts';

// A missing standard, altered upstream bytes or forged provenance must block the gate.
test('retained standard requires complete pinned bytes and provenance', async t => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  await checkEngineeringQualityStandard(repository);
  const root = await mkdtemp(join(tmpdir(), 'eqs-pin-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'standards'));
  const path = 'standards/engineering-quality-standard';
  const provenance = await readFile(join(repository, `${path}.provenance.json`));
  const bytes = await readFile(join(repository, `${path}.md`));
  await writeFile(join(root, `${path}.provenance.json`), provenance);
  await assert.rejects(checkEngineeringQualityStandard(root), { code: 'ENOENT' });
  await writeFile(join(root, `${path}.md`), Buffer.concat([bytes, Buffer.from('\n') ]));
  await assert.rejects(checkEngineeringQualityStandard(root), /retained bytes/);
  await writeFile(join(root, `${path}.md`), bytes);
  await writeFile(join(root, `${path}.provenance.json`), '{}');
  await assert.rejects(checkEngineeringQualityStandard(root), /provenance/);
});
