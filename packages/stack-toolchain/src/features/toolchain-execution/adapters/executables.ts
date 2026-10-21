import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { CheckerExecutable, CheckerExecutables } from './process.js';

const defaultRoot = fileURLToPath(new URL('../../../../', import.meta.url));
function readPins() {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(defaultRoot, 'toolchain-manifest.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('TOOLCHAIN_MANIFEST_INVALID'); }
  const record = value as Record<string, unknown>;
  const keys = ['bun', 'oxfmt', 'oxlint', 'oxlint-tsgolint', 'schemaVersion', 'tsrs', 'typescript'];
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) || record['schemaVersion'] !== 1) { throw new Error('TOOLCHAIN_MANIFEST_INVALID'); }
  const pin = (key: string): string => {
    const version = record[key];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) { throw new Error('TOOLCHAIN_MANIFEST_INVALID'); }
    return version;
  };
  pin('oxlint-tsgolint');
  return { typescript: pin('typescript'), bun: pin('bun'), tsrs: pin('tsrs'), oxlint: pin('oxlint'), oxfmt: pin('oxfmt') };
}
const pins = readPins();
function packageDirectory(name: string, root: string): string | null {
  const require = createRequire(path.join(root, 'package.json'));
  try {
    const resolved = path.dirname(require.resolve(`${name}/package.json`));
    const marker = `${path.sep}node_modules${path.sep}`;
    const realRoot = fs.realpathSync(root);
    const boundaryIndex = realRoot.indexOf(marker);
    if (boundaryIndex >= 0) {
      const boundary = realRoot.slice(0, boundaryIndex + marker.length - 1);
      const relative = path.relative(boundary, fs.realpathSync(resolved));
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {throw new Error('TOOLCHAIN_DEPENDENCY_OUTSIDE_INSTALLATION');}
    }
    return resolved;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {return null;}
    throw error;
  }
}
function validateOwner(tool: keyof typeof pins, root: string): void {
  const owner = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const declaration = owner.dependencies?.[tool] ?? owner.optionalDependencies?.[tool];
  let declaredPin = declaration;
  if (owner.name === 'stack-toolchain' && declaration === 'catalog:') {
    const workspaceRoot = path.resolve(root, '../..');
    const workspace = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as { private?: boolean; workspaces?: { packages?: string[]; catalog?: Record<string, string> } };
    if (workspace.private !== true || fs.realpathSync(root) !== fs.realpathSync(path.join(workspaceRoot, 'packages/stack-toolchain')) || workspace.workspaces?.packages?.includes('packages/*') !== true) {throw new Error('TOOLCHAIN_WORKSPACE_AUTHORITY');}
    declaredPin = workspace.workspaces.catalog?.[tool];
  }
  if (owner.name === 'stack-toolchain' && declaredPin !== pins[tool]) {throw new Error(`TOOLCHAIN_DEPENDENCY_DECLARATION:${tool}`);}
}
function nativePlatform(tool: keyof typeof pins): { name: string; arch: string; libc: string } {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' && tool === 'bun' ? 'aarch64' : process.arch;
  const libc = process.platform === 'linux' ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime !== undefined ? 'gnu' : 'musl') : '';
  const name = tool === 'typescript' ? `@typescript/typescript-${process.platform}-${process.arch}`
    : tool === 'bun' ? `@oven/bun-${platform}-${arch}${libc === 'musl' ? '-musl' : ''}`
    : tool === 'tsrs' ? `@tsrs/${process.platform}-${arch}${libc ? `-${libc}` : ''}`
    : `@${tool}/binding-${process.platform}-${arch}${libc ? `-${libc}` : process.platform === 'win32' ? '-msvc' : ''}`;
  return { name, arch, libc };
}
function native(tool: keyof typeof pins, root: string): CheckerExecutable | null {
  validateOwner(tool, root);
  const directory = packageDirectory(tool, root);
  if (directory === null) { if (tool === 'typescript') {throw new Error('TOOLCHAIN_REQUIRED_COMPILER_MISSING');} return null; }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { version: string; optionalDependencies?: Record<string, string> };
  if (manifest.version !== pins[tool]) {throw new Error(`TOOLCHAIN_PIN_MISMATCH:${tool}`);}
  const { name, arch, libc } = nativePlatform(tool);
  if (manifest.optionalDependencies?.[name] !== pins[tool]) { if (tool === 'typescript') {throw new Error('TOOLCHAIN_REQUIRED_COMPILER_UNSUPPORTED');} return null; }
  const nativeDirectory = packageDirectory(name, directory);
  if (nativeDirectory === null) { if (tool === 'typescript') {throw new Error('TOOLCHAIN_REQUIRED_COMPILER_MISSING');} return null; }
  const installed = JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'package.json'), 'utf8')) as { version: string };
  if (installed.version !== pins[tool]) {throw new Error(`TOOLCHAIN_NATIVE_PIN_MISMATCH:${tool}`);}
  return nativeCommand(tool, directory, nativeDirectory, arch, libc);
}
function nativeCommand(tool: keyof typeof pins, directory: string, nativeDirectory: string, arch: string, libc: string): CheckerExecutable {
  if (tool === 'oxlint' || tool === 'oxfmt') {
    if (process.release.name !== 'node' || 'bun' in process.versions) {throw new Error('TOOLCHAIN_NODE_REQUIRED');}
    const binding = path.join(nativeDirectory, `${tool}.${process.platform}-${arch}${libc ? `-${libc}` : process.platform === 'win32' ? '-msvc' : ''}.node`);
    if (!fs.statSync(binding).isFile()) {throw new Error(`TOOLCHAIN_NATIVE_BINARY_MISSING:${tool}`);}
    return { command: process.execPath, prefix: [path.join(directory, 'bin', tool)] };
  }
  const executable = tool === 'typescript' ? path.join(nativeDirectory, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
    : tool === 'bun' ? path.join(nativeDirectory, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')
    : path.join(nativeDirectory, process.platform === 'win32' ? `${tool}.exe` : tool);
  if (!fs.existsSync(executable)) {throw new Error(`TOOLCHAIN_NATIVE_BINARY_MISSING:${tool}`);}
  fs.accessSync(executable, fs.constants.X_OK);
  return { command: executable, prefix: [], ...(tool === 'bun' ? { cwd: nativeDirectory } : {}) };
}
export function resolveCompilerExecutable(packageRoot: string = defaultRoot): CheckerExecutable {
  const value = native('typescript', packageRoot);
  if (value === null) {throw new Error('TOOLCHAIN_REQUIRED_COMPILER_MISSING');}
  return value;
}
export function resolveExecutables(packageRoot: string = defaultRoot): CheckerExecutables {
  return { tsrs: native('tsrs', packageRoot), bun: native('bun', packageRoot), typescript: native('typescript', packageRoot) };
}
export function resolveToolExecutable(tool: 'oxlint' | 'oxfmt', packageRoot: string = defaultRoot): CheckerExecutable {
  const executable = native(tool, packageRoot);
  if (executable === null) {throw new Error(`TOOLCHAIN_REQUIRED_TOOL_MISSING:${tool}`);}
  return executable;
}

export function resolveTsgolintExecutable(packageRoot: string = defaultRoot): string {
  const directory = packageDirectory('oxlint-tsgolint', packageRoot);
  if (directory === null) { throw new Error('TOOLCHAIN_TSGOLINT_MISSING'); }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { version: string; optionalDependencies: Record<string, string> };
  const pin = JSON.parse(fs.readFileSync(path.join(defaultRoot, 'toolchain-manifest.json'), 'utf8')) as Record<string, string>;
  const name = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
  if (manifest.version !== pin['oxlint-tsgolint'] || manifest.optionalDependencies[name] !== manifest.version) { throw new Error('TOOLCHAIN_TSGOLINT_PIN_MISMATCH'); }
  const nativeRoot = packageDirectory(name, directory);
  if (nativeRoot === null) { throw new Error('TOOLCHAIN_TSGOLINT_NATIVE_MISSING'); }
  const installed = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8')) as { version: string };
  if (installed.version !== manifest.version) { throw new Error('TOOLCHAIN_TSGOLINT_NATIVE_PIN_MISMATCH'); }
  const executable = path.join(nativeRoot, process.platform === 'win32' ? 'tsgolint.exe' : 'tsgolint');
  fs.accessSync(executable, fs.constants.X_OK);
  return executable;
}
