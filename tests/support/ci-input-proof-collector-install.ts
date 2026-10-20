import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveQualificationExecutables } from '../../tools/executable-policy.mts';
import { resolvePnpmInvocation } from '../../tools/pnpm-command.mts';
import { readRepositoryRuntimePolicy } from '../../tools/runtime-policy.mts';

export const collectorFixtureInstallerPath = fileURLToPath(import.meta.url);

async function installCollectorPnpmGraph(sourceRoot: string, destinationRoot: string): Promise<void> {
  const policy = await readRepositoryRuntimePolicy(sourceRoot);
  const runtime = await resolveQualificationExecutables('node');
  const pnpm = await resolvePnpmInvocation(runtime.node, policy.toolchain.pnpm.version);
  await writeFile(join(destinationRoot, 'package.json'), JSON.stringify({
    name: 'ci-input-proof-collector-TEST',
    private: true,
    type: 'module',
    packageManager: `pnpm@${policy.toolchain.pnpm.version}`,
    dependencies: { '@agent-teams/ci-input-proof': 'file:packages/ci-input-proof' },
  }));
  await writeFile(join(destinationRoot, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  await promisify(execFile)(pnpm.command, [
    ...pnpm.args, '--pm-on-fail=ignore', 'install', '--offline',
    '--ignore-scripts', '--no-frozen-lockfile',
  ], {
    cwd: destinationRoot,
    env: process.env,
    timeout: 30_000,
    maxBuffer: 1_048_576,
  });
}

const scriptPath = process.argv.at(1);
if (scriptPath !== undefined && resolve(scriptPath) === collectorFixtureInstallerPath) {
  const sourceRoot = process.argv.at(2);
  const destinationRoot = process.argv.at(3);
  if (sourceRoot === undefined || destinationRoot === undefined || process.argv.length !== 4) {
    throw new Error('Collector TEST installer requires its source and owned destination.');
  }
  await installCollectorPnpmGraph(sourceRoot, destinationRoot);
}
