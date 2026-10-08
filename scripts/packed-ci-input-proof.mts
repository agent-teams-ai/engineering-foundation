import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

type Artifact = Readonly<{ archivePath: string; packageVersion: string }>;
type RunPnpm = (args: string[], root: string) => Promise<unknown>;
const runFile = promisify(execFile);

/** Reuses the existing packed qualification lane and its verified artifact. */
export async function verifyPackedCiInputProof(
  artifact: Artifact, temporaryRoot: string, repositoryRoot: string, runPnpm: RunPnpm,
): Promise<void> {
  const root = join(temporaryRoot, 'ci-input-proof-TEST-consumer');
  await mkdir(root, { recursive: false });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'ci-input-proof-test-consumer', private: true, type: 'module',
    devDependencies: { '@agent-teams/ci-input-proof': pathToFileURL(artifact.archivePath).href },
  }));
  await runPnpm(['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], root);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, module: 'NodeNext', target: 'ES2024',
      types: [], noEmit: true, verbatimModuleSyntax: true, resolveJsonModule: true }, files: ['probe.mts'],
  }));
  await writeFile(join(root, 'probe.mts'), [
    "import { compareLeafInventories } from '@agent-teams/ci-input-proof';",
    "import type { ComparisonResult, InputLeaf, LeafInventory } from '@agent-teams/ci-input-proof';",
    "import manifest from '@agent-teams/ci-input-proof/package.json' with { type: 'json' };",
    `if (manifest.version !== ${JSON.stringify(artifact.packageVersion)}) { throw new Error('packed version mismatch'); }`,
    "const before: LeafInventory = { version: 1, digestScheme: 'sha256', inputs: [",
    "  { path: 'package.json', type: 'file', mode: '100644', membership: 'closed', content: '1'.repeat(64) },",
    "  { path: 'src/a.ts', type: 'file', mode: '100644', membership: 'structural', content: '2'.repeat(64) },",
    '] };',
    "const changedFile: InputLeaf = { path: 'src/a.ts', type: 'file', mode: '100644', membership: 'structural', content: '3'.repeat(64) };",
    "const after: LeafInventory = { ...before, inputs: [before.inputs[0]!, changedFile] };",
    "const result: ComparisonResult = compareLeafInventories(before, after, ['src/a.ts']);",
    "if (result.status !== 'compatible-inputs' || result.changedContentPaths.join() !== 'src/a.ts') { throw new Error('packed behavior mismatch'); }",
    "if (!Object.isFrozen(result) || !Object.isFrozen(result.changedContentPaths)) { throw new Error('packed result is mutable'); }",
    "const denied = compareLeafInventories(before, after, []);",
    "if (denied.status !== 'rejected' || denied.reason !== 'closed-input-changed') { throw new Error('packed permission bypass'); }",
    'function typeContractOnly(result: ComparisonResult) {',
    "  if (result.status === 'compatible-inputs') {",
    '    // @ts-expect-error Public result must remain readonly.',
    "    result.changedContentPaths.push('forbidden');",
    '  }',
    '}',
    'void typeContractOnly;',
    'function leafTypeContractOnly() {',
    "  const executable: InputLeaf = { path: 'run', type: 'file', mode: '100755', membership: 'closed', content: '4'.repeat(64) };",
    "  const symlink: InputLeaf = { path: 'link', type: 'symlink', mode: '120000', membership: 'closed', content: '5'.repeat(64) };",
    "  const gitlink: InputLeaf = { path: 'submodule', type: 'gitlink', mode: '160000', membership: 'closed', content: '6'.repeat(64) };",
    '  // @ts-expect-error File leaves cannot carry a symlink mode.',
    "  const invalidFile: InputLeaf = { path: 'file', type: 'file', mode: '120000', membership: 'closed', content: '7'.repeat(64) };",
    '  // @ts-expect-error Symlink leaves cannot carry a gitlink mode.',
    "  const invalidSymlink: InputLeaf = { path: 'link', type: 'symlink', mode: '160000', membership: 'closed', content: '8'.repeat(64) };",
    '  // @ts-expect-error Gitlink leaves cannot carry a file mode.',
    "  const invalidGitlink: InputLeaf = { path: 'submodule', type: 'gitlink', mode: '100644', membership: 'closed', content: '9'.repeat(64) };",
    '  return [executable, symlink, gitlink, invalidFile, invalidSymlink, invalidGitlink];',
    '}',
    'void leafTypeContractOnly;',
    "try { await import('@agent-teams/ci-input-proof/' + 'dist/index.js'); throw new Error('deep import admitted'); }",
    "catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') { throw error; } }",
  ].join('\n'));
  // Compile with the repository's pinned compiler, resolving the installed
  // package from the disposable consumer, not a workspace or source alias.
  await runPnpm(['exec', 'tsc', '--project', join(root, 'tsconfig.json')], repositoryRoot);
  await runFile(process.execPath, [join(root, 'probe.mts')], { cwd: root });
}
