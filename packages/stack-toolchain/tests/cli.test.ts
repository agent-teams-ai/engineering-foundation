import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function run(args: readonly string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 10_000 });
}
test('CLI rejects unknown command without launching tools', () => {
  const result = run(['unknown']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/u);
});
test('CLI rejects unknown options without resolving native binaries', () => {
  const result = run(['typecheck', '--force-engine', 'typescript']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TOOLCHAIN_UNKNOWN_ARGUMENT/u);
});
test('CLI rejects absent config argument', () => {
  const result = run(['typecheck', '--config']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TOOLCHAIN_UNKNOWN_ARGUMENT/u);
});

test('API rejects invalid budget before configuration or executable resolution', async () => {
  const { runCommand } = await import('../dist/features/toolchain-execution/adapters/commands.js');
  const result = await runCommand({ command: 'typecheck', cwd: '/nonexistent', signal: new AbortController().signal, budgetMs: 0 });
  assert.equal(result.exitCode, 2);
  assert.match(JSON.stringify(result.details), /TOOLCHAIN_INVALID_BUDGET/u);
});
test('API honors already cancelled caller before reading configuration', async () => {
  const { runCommand } = await import('../dist/features/toolchain-execution/adapters/commands.js');
  const result = await runCommand({ command: 'typecheck', cwd: '/nonexistent', signal: AbortSignal.abort() });
  assert.equal(result.exitCode, 130);
});
test('API budget expiration is tooling failure rather than caller cancellation', async () => {
  const { runCommand } = await import('../dist/features/toolchain-execution/adapters/commands.js');
  const controller = new AbortController();
  const result = await runCommand({ command: 'typecheck', cwd: process.cwd(), signal: controller.signal, budgetMs: 1 });
  assert.equal(result.exitCode, 2);
  assert.equal(controller.signal.aborted, false);
});

test('doctor rejects Bun as the mandatory CLI runtime', async () => {
  const { resolveExecutables } = await import('../src/features/toolchain-execution/adapters/executables.ts');
  const bun = resolveExecutables().bun;
  assert.notEqual(bun, null);
  const result = spawnSync(bun!.command, [entry, 'doctor', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /TOOLCHAIN_UNSUPPORTED_NODE_RUNTIME/u);
});
