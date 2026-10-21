import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveCompilerExecutable, resolveToolExecutable, resolveExecutables } from '../dist/features/toolchain-execution/adapters/executables.js';

test('compiler resolves qualified native tsc directly', () => {
  const executable = resolveCompilerExecutable();
  assert.match(executable.command, /[/\\]lib[/\\]tsc(?:\.exe)?$/u);
  assert.deepEqual(executable.prefix, []);
});
test('missing required compiler rejects without PATH fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-toolchain-executable-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    assert.throws(() => resolveCompilerExecutable(root), /TOOLCHAIN_REQUIRED_COMPILER_MISSING/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('installed wrong compiler pin is terminal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-toolchain-executable-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const directory = path.join(root, 'node_modules', 'typescript');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'typescript', version: '1.0.0' }));
    assert.throws(() => resolveCompilerExecutable(root), /TOOLCHAIN_PIN_MISMATCH/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installed qualified checker and NAPI routes resolve to existing files', () => {
  const engines = resolveExecutables();
  if (process.platform === "linux" || (process.platform === "darwin" && process.arch === "arm64")) { assert.ok(engines.tsrs); }
  assert.ok(engines.bun);
  for (const executable of Object.values(engines)) {
    if (executable === null) {continue;}
    assert.ok(fs.statSync(executable.command).isFile());
  }
  for (const tool of ['oxlint', 'oxfmt'] as const) {
    const executable = resolveToolExecutable(tool);
    assert.equal(executable.command, process.execPath);
    assert.ok(fs.statSync(executable.prefix[0]!).isFile());
  }
});
