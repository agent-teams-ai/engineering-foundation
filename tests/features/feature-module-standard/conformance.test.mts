import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { test } from 'node:test';
import { ERROR_CODES, WARNING_CODES, checkFeatureModule } from '../../../packages/feature-module-standard/dist/index.js';
import type { ImportRecord } from '../../../packages/feature-module-standard/dist/index.js';
import { conformanceCases, exampleModule, exampleSources } from '../../../packages/feature-module-standard/dist/fixtures.js';

for (const fixture of conformanceCases) {
  void test(`fixture ${fixture.id}`, () => {
    const report = checkFeatureModule(fixture.input);
    assert.deepEqual(report.diagnostics.map(({ code }) => code).toSorted(), [...fixture.expect].toSorted(), fixture.description);
    assert.equal(report.ok, fixture.ok);
  });
}

void test('fixture ids are unique and every rejecting code is exercised', () => {
  assert.equal(new Set(conformanceCases.map(({ id }) => id)).size, conformanceCases.length);
  const exercised = new Set(conformanceCases.flatMap(({ expect }) => expect));
  for (const code of [...ERROR_CODES, ...WARNING_CODES]) { assert.ok(exercised.has(code), code); }
});

void test('the report does not depend on input order and leaves the input untouched', () => {
  const base = conformanceCases.find(({ id }) => id === 'lateral-and-downward-cycle')?.input;
  assert.ok(base);
  const frozen = structuredClone(base);
  const shuffled = { ...base, files: base.files.toReversed(), imports: base.imports.toReversed() };
  assert.deepEqual(checkFeatureModule(shuffled), checkFeatureModule(base));
  assert.deepEqual(base, frozen);
});


// A minimal reader for the three statement forms of the materialized example: the runner's parser would take this place.
function readImports(sources: Readonly<Record<string, string>>): ImportRecord[] {
  return Object.entries(sources).flatMap(([from, text]) => text.split('\n').flatMap((line, index) => {
    const match = /^(import type \{\} from|export \* from|import) '([^']+)';$/u.exec(line);
    if (match === null) { return []; }
    const to = posix.normalize(posix.join(posix.dirname(from), match[2] ?? ''));
    const mode = match[1] === 'import type {} from' ? 'type-only' : 'runtime';
    return [{ from, to, mode, line: index + 1, ...(match[1] === 'export * from' ? { reexport: true } : {}) } satisfies ImportRecord];
  }));
}

void test('the materialized example tree reads back to the same edges and the same report', () => {
  const module = exampleModule();
  const sources = exampleSources();
  assert.deepEqual(Object.keys(sources).toSorted(), module.files.toSorted());
  const key = (record: ImportRecord): string => `${record.from} ${record.to} ${record.mode} ${String(record.reexport === true)}`;
  assert.deepEqual(readImports(sources).map(key).toSorted(), module.imports.map(key).toSorted());
  assert.deepEqual(checkFeatureModule({ ...module, imports: readImports(sources) }), checkFeatureModule(module));
});
