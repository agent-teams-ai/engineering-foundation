import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const provisioned = process.env.MANAGED_TEST_TOOLS_ROOT ?? join(workspace, '.local/node-tools');
export const parent = process.env.MANAGED_TEST_ROOT ?? join(workspace, '.local/node26-evidence');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Test-side independent whole-tree oracle; never calls the production identity reader. */
async function tree(root) {
  const records = [];
  async function visit(dir) {
    for (const name of (await readdir(dir)).toSorted()) {
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isDirectory()) {await visit(path);}
      else {
        if (!info.isFile()) {throw new Error('fixture package contains non-file');}
        records.push([relative(root, path).replaceAll('\\', '/'), info.mode,
          info.size, sha(await readFile(path))]);
      }
    }
  }
  await visit(root);
  records.sort((a, b) => a[0].localeCompare(b[0], 'en'));
  return sha(`agent-teams.managed-pnpm-tree/v1\n${JSON.stringify(records)}`);
}
export async function fixture(nodeLane) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'TEST-managed-runtime-'));
  const sourceNode = join(provisioned, nodeLane, 'bin/node');
  const sourcePnpm = join(provisioned, 'pnpm/node_modules/pnpm');
  const trusted = {
    nodeSha: sha(await readFile(sourceNode)),
    manifestSha: sha(await readFile(join(sourcePnpm, 'package.json'))),
    entrySha: sha(await readFile(join(sourcePnpm, 'bin/pnpm.mjs'))),
    treeSha: await tree(sourcePnpm)
  };
  const node = join(root, 'runtime/bin/node');
  const packageRoot = join(root, 'pnpm');
  await mkdir(join(root, 'runtime/bin'), { recursive: true });
  await copyFile(sourceNode, node);
  await cp(sourcePnpm, packageRoot, { recursive: true, dereference: false });
  const expected = { nodeVersion: nodeLane === 'node24' ? '24.21.0' : '26.10.0',
    pnpmVersion: '11.20.0', platform: 'linux', architecture: 'x64' };
  const selection = { selectedNode: { path: node, expectedSha256: trusted.nodeSha },
    pnpmPackage: { root: packageRoot, expectedManifestSha256: trusted.manifestSha,
      expectedEntrySha256: trusted.entrySha, expectedTreeDigest: trusted.treeSha,
      entryRelativePath: 'bin/pnpm.mjs' }, expected, launcher: 'direct-node' };
  return { root, node, packageRoot, expected, selection, trusted,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Negative-only synthetic package binding; never used as real pnpm success evidence. */
export async function negativePackageSelection(f) {
  return { ...f.selection, pnpmPackage: { ...f.selection.pnpmPackage,
    expectedEntrySha256: sha(await readFile(join(f.packageRoot, 'bin/pnpm.mjs'))),
    expectedTreeDigest: await tree(f.packageRoot) } };
}
