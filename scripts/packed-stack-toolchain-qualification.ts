import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from './pack-test-support.mjs';

/** Runs only against an installed candidate in a disposable package consumer. */
export async function qualifyInstalledStackToolchain(consumerRoot: string): Promise<void> {
  const root = join(consumerRoot, 'TEST-stack-toolchain');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { check: 'exit 99' } }));
  await writeFile(join(root, 'index.ts'), 'export const value: string = "ready";\n');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ files: ['index.ts'], compilerOptions: { strict: true, skipLibCheck: true, outDir: 'dist' } }));
  await writeFile(join(root, '.oxlintrc.json'), '{}');
  await writeFile(join(root, 'toolchain.config.json'), JSON.stringify({ schemaVersion: 1, profile: 'typescript-node', typecheck: { projects: ['tsconfig.json'] }, lint: { config: '.oxlintrc.json', paths: ['index.ts'] }, format: { paths: ['index.ts'] } }));
  await writeFile(join(root, 'oxfmt.config.ts'), 'import fs from "node:fs"; fs.writeFileSync("formatter-marker", "executed"); export default {};');
  const cli = join(consumerRoot, 'node_modules/stack-toolchain/dist/cli.js');
  for (const command of ['doctor', 'typecheck', 'lint', 'format:check']) {
    const result = await runCommand(process.execPath, [cli, command, '--json'], root);
    assert.equal(JSON.parse(result.stdout).exitCode, 0, command);
  }
  await runCommand(process.execPath, [cli, 'compile', '--json', '--project', 'tsconfig.json'], root);
  assert.match(await readFile(join(root, 'dist/index.js'), 'utf8'), /ready/u);
  await assert.rejects(readFile(join(root, 'formatter-marker')), /ENOENT/u);
  const original = await readFile(join(root, 'index.ts'), 'utf8');
  await writeFile(join(root, 'index.ts'), 'export const value: string = 12;\n');
  let output = '';
  try { await runCommand(process.execPath, [cli, 'typecheck', '--json'], root); }
  catch (error) { output = String((error as { stdout?: string }).stdout); }
  assert.match(output, /TS2322/u);
  await writeFile(join(root, 'index.ts'), 'export const value:string="ready"');
  let formattingFailed = false;
  try { await runCommand(process.execPath, [cli, 'format:check', '--json'], root); }
  catch { formattingFailed = true; }
  assert.equal(formattingFailed, true);
  assert.equal(await readFile(join(root, 'index.ts'), 'utf8'), 'export const value:string="ready"');
  await writeFile(join(root, 'index.ts'), original);
}
