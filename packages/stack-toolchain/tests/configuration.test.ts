import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfiguration } from '../dist/features/toolchain-execution/adapters/configuration.js';

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-toolchain-config-'));
  fs.writeFileSync(path.join(root, 'index.ts'), 'const value: string = 12;');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ files: ['index.ts'] }));
  fs.writeFileSync(path.join(root, '.oxlintrc.json'), '{}');
  fs.writeFileSync(path.join(root, 'toolchain.config.json'), JSON.stringify({ schemaVersion: 1, profile: 'typescript-node', typecheck: { projects: ['tsconfig.json'] }, lint: { config: '.oxlintrc.json', paths: ['.'] }, format: { paths: ['.'] } }));
  return root;
}
test('official parser accepts config without semantic checking', async () => {
  const root = fixture();
  try { assert.deepEqual((await loadConfiguration({ cwd: root })).projects, [path.join(root, 'tsconfig.json')]); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('rejects unknown fields and ancestor discovery', async () => {
  const root = fixture();
  try {
    const file = path.join(root, 'toolchain.config.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...value, fallbackOnDiagnostics: true }));
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_CONFIG_FIELDS/u);
    fs.mkdirSync(path.join(root, 'child'));
    await assert.rejects(loadConfiguration({ cwd: path.join(root, 'child') }), /ENOENT/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('rejects references and empty source scope', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [] }));
    await assert.rejects(loadConfiguration({ cwd: root }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['absent/**/*.ts'] }));
    await assert.rejects(loadConfiguration({ cwd: root }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects direct and inherited noCheck before checker execution', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { noCheck: true } }));
    for (const config of [{ files: ['index.ts'], compilerOptions: { noCheck: true } }, { extends: './base.json', files: ['index.ts'] }]) {
      fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
      await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_NOCHECK_UNSUPPORTED/u);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('accepts inherited composite without writing metadata during configuration', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { composite: true } }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['index.ts'] }));
    await loadConfiguration({ cwd: root });
    assert.equal(fs.existsSync(path.join(root, 'tsconfig.tsbuildinfo')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('rejects option injection in lint and format paths', async () => {
  const root = fixture();
  try {
    const file = path.join(root, 'toolchain.config.json');
    const source = fs.readFileSync(file, 'utf8');
    for (const field of ['lint', 'format']) {
      const value = JSON.parse(source) as Record<string, { paths: string[] }>;
      value[field]!.paths = ['--version'];
      fs.writeFileSync(file, JSON.stringify(value));
      await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_CONFIG_PATH/u);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects executable lint configs and inherited JavaScript plugins', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'parent.json'), JSON.stringify({ overrides: [{ jsPlugins: ['./plugin.js'] }] }));
    fs.writeFileSync(path.join(root, '.oxlintrc.json'), JSON.stringify({ extends: ['./parent.json'] }));
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_CONFIG_EXECUTABLE/u);
    const filename = path.join(root, 'toolchain.config.json');
    const config = JSON.parse(fs.readFileSync(filename, 'utf8')) as { lint: { config: string } };
    config.lint.config = 'config.ts';
    fs.writeFileSync(filename, JSON.stringify(config));
    fs.writeFileSync(path.join(root, 'config.ts'), 'throw new Error("must never execute")');
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('permits shared JSON preset diamonds while rejecting actual cycles', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'base.json'), '{}');
    fs.writeFileSync(path.join(root, 'a.json'), '{"extends":["./base.json"]}');
    fs.writeFileSync(path.join(root, 'b.json'), '{"extends":["./base.json"]}');
    fs.writeFileSync(path.join(root, '.oxlintrc.json'), '{"extends":["./a.json","./b.json"]}');
    await loadConfiguration({ cwd: root });
    fs.writeFileSync(path.join(root, 'base.json'), '{"extends":["./a.json"]}');
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects hidden semantic type checks in inherited lint overrides', async () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'parent.json'), JSON.stringify({ overrides: [{ options: { typeCheck: true } }] }));
    fs.writeFileSync(path.join(root, '.oxlintrc.json'), '{"extends":["./parent.json"]}');
    await assert.rejects(loadConfiguration({ cwd: root }), /TOOLCHAIN_LINT_SEMANTIC_CHECK_UNSUPPORTED/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
