import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FileLeaf, JsonRecord, LeafShape } from '../packages/release-checks/dist/index.js';
import { assertExplicitSourceGitAuthority } from '../tools/profile-root.mts';

const execFileAsync = promisify(execFile);
export type ReleaseGitAuthority = Awaited<ReturnType<typeof assertExplicitSourceGitAuthority>>;
export interface ReleaseTreeEntry { readonly objectId: string; readonly shape: LeafShape }
export type ReleaseTree = ReadonlyMap<string, ReleaseTreeEntry>;
export interface ReleaseFileBytes { readonly bytes: Buffer; readonly file: FileLeaf }
export interface ChangesetsInstallation {
  readonly name: '@changesets/cli';
  readonly version: '2.31.1';
  readonly digest: string;
  readonly entrypoint: string;
  readonly nodeExecutable: string;
  readonly custodyDigest: string;
}

export function releaseDigest(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function releaseJsonDigest(value: unknown): string {
  return releaseDigest(JSON.stringify(value));
}

export function releaseObject(bytes: Buffer, label: string): JsonRecord {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) { throw new Error(`${label} must contain UTF-8 JSON.`); }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${label} must contain a JSON object.`); }
  return value as JsonRecord;
}

export async function releaseGit(authority: ReleaseGitAuthority, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd: authority.sourceRoot, env: authority.environment, encoding: 'utf8',
    timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  return result.stdout;
}

function portablePath(path: string): void {
  const hasControl = [...path].some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
  if (path === '' || path.includes('\\') || path.startsWith('/') || hasControl ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Release observation encountered a nonportable Git path.');
  }
}

export async function readReleaseTree(authority: ReleaseGitAuthority, revision: string): Promise<ReleaseTree> {
  if (!/^[a-f0-9]{40}$/u.test(revision)) { throw new Error('Release source must be an exact commit.'); }
  const output = await releaseGit(authority, ['ls-tree', '-r', '-z', revision]);
  const entries = new Map<string, ReleaseTreeEntry>();
  for (const row of output.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    if (match === null) { throw new Error('Release tree contains an unsupported entry.'); }
    const mode = match[1]!; const kind = match[2]!; const objectId = match[3]!; const path = match[4]!;
    portablePath(path);
    if (entries.has(path) || (mode === '160000') !== (kind === 'commit')) { throw new Error('Release tree contains ambiguous file evidence.'); }
    const shape: LeafShape = mode === '160000' ? { type: 'gitlink', mode }
      : mode === '120000' ? { type: 'symlink', mode }
      : { type: 'file', mode: mode as '100644' | '100755' };
    entries.set(path, { objectId, shape });
  }
  return entries;
}

export async function readReleaseGitFile(authority: ReleaseGitAuthority, tree: ReleaseTree, path: string): Promise<ReleaseFileBytes | null> {
  const entry = tree.get(path);
  if (entry === undefined) { return null; }
  if (entry.shape.type === 'gitlink') {
    return { bytes: Buffer.from(entry.objectId), file: { ...entry.shape, digest: releaseDigest(entry.objectId) } };
  }
  const { stdout } = await execFileAsync('git', ['cat-file', 'blob', entry.objectId], {
    cwd: authority.sourceRoot, env: authority.environment, encoding: 'buffer',
    timeout: 30_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  return { bytes: stdout, file: { ...entry.shape, digest: releaseDigest(stdout) } };
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const).every(key => before[key] === after[key]);
}

async function readReleaseLink(absolute: string, path: string, metadata: BigIntStats, parent: string): Promise<ReleaseFileBytes> {
  if (await realpath(dirname(absolute)) !== parent) { throw new Error(`Release path has substituted directory ancestry: ${path}.`); }
  const bytes = Buffer.from(await readlink(absolute));
  if (!sameFile(metadata, await lstat(absolute, { bigint: true }))) { throw new Error(`Release link changed during observation: ${path}.`); }
  if (await realpath(dirname(absolute)) !== parent) { throw new Error(`Release path has substituted directory ancestry: ${path}.`); }
  return { bytes, file: { type: 'symlink', mode: '120000', digest: releaseDigest(bytes) } };
}

async function readReleaseHandle(handle: FileHandle, size: bigint): Promise<Buffer> {
  // Read at most the observed size plus one byte, even if the file grows.
  const bytes = Buffer.alloc(Number(size) + 1);
  let length = 0;
  while (length < bytes.length) {
    const result = await handle.read(bytes, length, bytes.length - length, null);
    if (result.bytesRead === 0) { break; }
    length += result.bytesRead;
  }
  return bytes.subarray(0, length);
}

export async function readReleaseWorkingFile(root: string, path: string): Promise<ReleaseFileBytes | null> {
  portablePath(path);
  const absolute = join(root, path);
  // Do not follow a replaced ancestor outside this execution's source root.
  const parent = await realpath(dirname(absolute)).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return null; }
    throw error;
  });
  if (parent === null) { return null; }
  const relativeParent = relative(root, parent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || resolve(parent, path.split('/').at(-1)!) !== absolute) {
    throw new Error(`Release path has substituted directory ancestry: ${path}.`);
  }
  const portableFlags: Partial<Pick<typeof constants, 'O_NOFOLLOW' | 'O_NONBLOCK'>> = constants;
  let handle: FileHandle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (portableFlags.O_NOFOLLOW ?? 0) | (portableFlags.O_NONBLOCK ?? 0));
  } catch (error) {
    // A no-follow open refuses links; observe their literal bytes, including
    // dangling links, without opening or consuming the target.
    const metadata = await lstat(absolute, { bigint: true }).catch((failure: unknown) => {
      if (failure instanceof Error && 'code' in failure && failure.code === 'ENOENT') { return null; }
      throw failure;
    });
    if (metadata?.isSymbolicLink() === true) { return readReleaseLink(absolute, path, metadata, parent); }
    if (metadata === null && error instanceof Error && 'code' in error && error.code === 'ENOENT') { return null; }
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(absolute, { bigint: true });
    // Platforms without O_NOFOLLOW can open the target, but never read it.
    if (pathMetadata.isSymbolicLink()) { return await readReleaseLink(absolute, path, pathMetadata, parent); }
    if (!metadata.isFile() || metadata.size >= 2n ** 31n) { throw new Error(`Release path is not an ordinary bounded file: ${path}.`); }
    if (!sameFile(metadata, pathMetadata) || await realpath(dirname(absolute)) !== parent) { throw new Error(`Release file changed before its read: ${path}.`); }
    const bytes = await readReleaseHandle(handle, metadata.size);
    if (BigInt(bytes.length) !== metadata.size || !sameFile(metadata, await handle.stat({ bigint: true })) ||
        !sameFile(metadata, await lstat(absolute, { bigint: true })) || await realpath(dirname(absolute)) !== parent) { throw new Error(`Release file changed during observation: ${path}.`); }
    return { bytes, file: { type: 'file', mode: (metadata.mode & 0o111n) === 0n ? '100644' : '100755', digest: releaseDigest(bytes) } };
  } finally { await handle.close(); }
}

export async function readReleaseWorkingTree(authority: ReleaseGitAuthority, before: ReleaseTree): Promise<ReleaseTree> {
  const untracked = await releaseGit(authority, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked !== '') { throw new Error(`Untracked release outputs are not admitted: ${untracked.split('\0').filter(Boolean).join(', ')}.`); }
  const tracked = (await releaseGit(authority, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const tree = new Map<string, ReleaseTreeEntry>();
  for (const path of [...new Set([...before.keys(), ...tracked])].toSorted()) {
    const observed = await readReleaseWorkingFile(authority.sourceRoot, path);
    if (observed === null) { continue; }
    const objectId = createHash('sha1').update(`blob ${observed.bytes.length}\0`).update(observed.bytes).digest('hex');
    const { digest: _digest, ...shape } = observed.file;
    tree.set(path, { objectId, shape });
  }
  return tree;
}

export function releaseTreeDigest(tree: ReleaseTree): string {
  return releaseJsonDigest([...tree].toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export async function requireReleaseFile(read: (path: string) => Promise<ReleaseFileBytes | null>, path: string): Promise<ReleaseFileBytes> {
  const file = await read(path);
  if (file?.file.type !== 'file' || file.file.mode !== '100644') { throw new Error(`${path} must be an ordinary nonexecutable release input.`); }
  return file;
}

async function packageRootFor(entrypoint: string): Promise<string> {
  let candidate = dirname(await realpath(entrypoint));
  for (let depth = 0; depth < 32; depth += 1) {
    if (await lstat(join(candidate, 'package.json')).then(stat => stat.isFile(), () => false)) {
      const manifest = releaseObject(await readFile(join(candidate, 'package.json')), 'Changesets runtime package');
      if (typeof manifest['name'] === 'string' && typeof manifest['version'] === 'string') { return candidate; }
    }
    const parent = dirname(candidate);
    if (candidate === parent) { break; }
    candidate = parent;
  }
  throw new Error('The resolved Changesets dependency has no owning package manifest.');
}

async function installedPackageFiles(root: string): Promise<readonly [string, string][]> {
  const files: [string, string][] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === 'node_modules' || entry.name === '.git') { continue; }
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) { await walk(path); }
      else if (entry.isFile()) {
        const file = await readReleaseWorkingFile(root, path);
        if (file === null) { throw new Error('The Changesets installation changed while being observed.'); }
        files.push([path, file.file.digest]);
      } else { throw new Error(`The Changesets installation contains an unsupported link: ${path}.`); }
    }
  };
  await walk('');
  return files;
}

async function installedDependencies(root: string, manifest: JsonRecord): Promise<readonly [string, string][]> {
  const dependencies: [string, string][] = [];
  const declarations = manifest['dependencies'];
  if (declarations !== undefined && (declarations === null || typeof declarations !== 'object' || Array.isArray(declarations))) { throw new Error('Installed Changesets dependencies are malformed.'); }
  const issuer = createRequire(join(root, 'package.json'));
  for (const name of Object.keys(declarations ?? {}).toSorted()) {
    let dependencyManifest: string;
    try { dependencyManifest = issuer.resolve(`${name}/package.json`); }
    catch { dependencyManifest = join(await packageRootFor(issuer.resolve(name)), 'package.json'); }
    dependencies.push([name, await realpath(dirname(dependencyManifest))]);
  }
  return dependencies;
}

/** Observe the installed runtime closure, including the configured formatter.
 * Package bytes and runtime version are portable across checkouts/platforms;
 * resolved paths and the native executable's bytes remain local custody. */
export async function observeChangesetsInstallation(config: JsonRecord, nodeExecutable = process.execPath,
  cliEntrypoint = createRequire(import.meta.url).resolve('@changesets/cli/bin.js')): Promise<ChangesetsInstallation> {
  const entrypoint = await realpath(cliEntrypoint);
  const node = await realpath(nodeExecutable);
  const cliRoot = await packageRootFor(entrypoint);
  const pending = [cliRoot];
  const formatter = Array.isArray(config['changelog']) ? config['changelog'][0] : config['changelog'];
  if (typeof formatter === 'string') {
    pending.push(await packageRootFor(createRequire(join(cliRoot, 'package.json')).resolve(formatter)));
  } else if (formatter !== false && formatter !== undefined) { throw new Error('Unsupported Changesets changelog configuration.'); }
  const packages = new Map<string, { readonly coordinate: string; readonly digest: string; readonly dependencies: readonly [string, string][] }>();
  while (pending.length > 0) {
    const root = await realpath(pending.pop()!);
    if (packages.has(root)) { continue; }
    if (packages.size >= 512) { throw new Error('The Changesets installation exceeds the admitted runtime closure.'); }
    const manifest = releaseObject(await readFile(join(root, 'package.json')), 'Installed Changesets package');
    if (typeof manifest['name'] !== 'string' || typeof manifest['version'] !== 'string') { throw new Error('The Changesets installation contains an unnamed package.'); }
    const dependencies = await installedDependencies(root, manifest);
    pending.push(...dependencies.map(([, dependencyRoot]) => dependencyRoot));
    packages.set(root, { coordinate: `${manifest['name']}@${manifest['version']}`,
      digest: releaseJsonDigest(await installedPackageFiles(root)), dependencies });
  }
  const cli = packages.get(cliRoot);
  if (cli?.coordinate !== '@changesets/cli@2.31.1') { throw new Error('Foundation release checks require the installed Changesets 2.31.1 CLI.'); }
  const nodeDigest = releaseDigest(await readFile(node));
  const runtimeVersion = (await execFileAsync(node, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })).stdout.trim();
  if (!/^v?\d+\.\d+\.\d+$/u.test(runtimeVersion)) { throw new Error('The Changesets runtime has no exact release version.'); }
  const graph = [...new Set([...packages.values()].map(pkg => JSON.stringify({ coordinate: pkg.coordinate, digest: pkg.digest,
    dependencies: pkg.dependencies.map(([name, root]) => [name, packages.get(root)?.coordinate, packages.get(root)?.digest]) })))].toSorted();
  return { name: '@changesets/cli', version: '2.31.1', digest: releaseJsonDigest({ runtimeVersion, graph }),
    entrypoint, nodeExecutable: node, custodyDigest: releaseJsonDigest({ entrypoint, node, nodeDigest, packages: [...packages.keys()].toSorted() }) };
}
