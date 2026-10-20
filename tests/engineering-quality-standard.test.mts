import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// A guidance identity retained only as history must never qualify a stale current pin.
test('runtime seam requires authenticated CMS inputs and unique current guidance pins', async t => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'runtime-guidance-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cms = 'docs/architecture/evidence/runtime-profile-guidance-20261020/common-assembly';
  const seamPath = 'docs/architecture/runtime-profile-static-seam.md';
  const paths = [
    'standards/engineering-quality-standard.md', 'standards/engineering-quality-standard.provenance.json',
    `${cms}.txt`, `${cms}.provenance.json`, `${cms}.diff`, seamPath,
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
  ];
  await Promise.all(paths.map(async path => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(repository, path), join(root, path));
  }));
  await checkEngineeringQualityStandard(root);

  for (const [path, expectedFailure] of [
    [`${cms}.txt`, /CMS retained bytes/],
    [`${cms}.provenance.json`, /CMS provenance/],
    [`${cms}.diff`, /CMS retained delta/],
  ] as const) {
    const original = await readFile(join(root, path));
    await rm(join(root, path));
    await assert.rejects(checkEngineeringQualityStandard(root), { code: 'ENOENT' });
    await writeFile(join(root, path), path.endsWith('.json') ? '{}' : Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(checkEngineeringQualityStandard(root), expectedFailure);
    await writeFile(join(root, path), original);
  }

  const seam = await readFile(join(root, seamPath), 'utf8');
  await writeFile(join(root, seamPath), seam.replace(/\r?\n/gu, '\r\n'));
  await checkEngineeringQualityStandard(root);
  await writeFile(join(root, seamPath), seam);
  for (const [label, stale] of [
    ['CMS guidance commit', '3dd68a6b26f42159714a4640b613534a55c2c6aa'],
    ['CMS guidance SHA-256', 'e5cb510c5ea83e54a6833cc40b6ad31fc5cf8c70d9838e4e0c6923edc6f70919'],
    ['CMS guidance commit', '7d6535dd86533566620040233290869825000d2b'],
    ['CMS guidance SHA-256', '859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a'],
    ['EQS guidance commit', 'f9f4c8ad381254fb07cba737d6443542348395c1'],
    ['EQS guidance SHA-256', 'd55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8'],
    ['Workflow boundary', 'pending'],
    ['Workflow owner', 'consumer-local'],
    ['Workflow lifecycle', 'Assembly adopted'],
  ]) {
    const changed = seam.split('\n').map(line => line.startsWith(`${label}:`)
      ? `${label}: \`${stale}\`` : line).join('\n');
    // Keep the correct identity as historical prose: substring checks must
    // not let that identity hide the changed current record.
    const history = seam.split('\n').filter(line => line.startsWith(`${label}:`)).join('\n');
    await writeFile(join(root, seamPath), `${changed}\nHistorical record: ${history}\n`);
    await assert.rejects(checkEngineeringQualityStandard(root), /current guidance/);
  }
  const current = seam.split('\n').find(line => line.startsWith('CMS guidance commit:'));
  assert.ok(current);
  await writeFile(join(root, seamPath), `${seam}\n${current}\n`);
  await assert.rejects(checkEngineeringQualityStandard(root), /current guidance/);
  await writeFile(join(root, seamPath), seam);
  for (const path of paths.slice(-6)) {
    const original = await readFile(join(root, path));
    await rm(join(root, path));
    await assert.rejects(checkEngineeringQualityStandard(root), /Runtime profile seam path is missing or unclassified/);
    await writeFile(join(root, path), original);
    assert.ok(seam.includes(path));
    await writeFile(join(root, seamPath), seam.replace(path, 'removed-workflow-path'));
    await assert.rejects(checkEngineeringQualityStandard(root), /Runtime profile seam path is missing or unclassified/);
    await writeFile(join(root, seamPath), seam);
  }
  const classification = 'Workflow boundary: `existing-static-adapter`';
  assert.ok(seam.includes(classification));
  await writeFile(join(root, seamPath), seam.replace(classification, ''));
  await assert.rejects(checkEngineeringQualityStandard(root), /current guidance/);
});
