import type { ImportRecord } from '../../feature-model/domain/model.js';
import { exampleModule } from './example-tree.js';

const segments = (path: string): string[] => path.split('/');

// Relative specifier from one repository file to another, with the extension kept.
function specifier(from: string, to: string): string {
  const base = segments(from).slice(0, -1);
  const target = segments(to);
  let shared = 0;
  while (shared < base.length && shared < target.length - 1 && base[shared] === target[shared]) { shared += 1; }
  const up = base.slice(shared).map(() => '..');
  return [...(up.length === 0 ? ['.'] : up), ...target.slice(shared)].join('/');
}

const statement = (record: ImportRecord): string => {
  const to = `'${specifier(record.from, record.to)}'`;
  if (record.reexport === true) { return `export * from ${to};`; }
  return record.mode === 'type-only' ? `import type {} from ${to};` : `import ${to};`;
};

/**
 * The example tree as real source files, path to text: `import '...'`, `export * from '...'` and `import type {} from '...'`
 * statements that name the same edges as `exampleModule().imports`. A runner materializes them, reads the statements back
 * through its own parser and must reproduce the kernel's report for `exampleModule()`.
 */
export function exampleSources(): Readonly<Record<string, string>> {
  const { files, imports } = exampleModule();
  return Object.fromEntries(files.map((file) => [file, [
    ...imports.filter((record) => record.from === file).map(statement),
    `export const origin = '${file}';`, '',
  ].join('\n')]));
}
