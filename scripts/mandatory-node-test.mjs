import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { join, relative, resolve as resolvePath, sep } from 'node:path';

import { runNodeTestExecution, validateNodeTestContract } from '../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.js';
import { repositoryRoot } from './check-test-manifests.mjs';

const contractPath = 'architecture/foundation/node-test-execution.json';

export async function maybeRunMandatoryNodeTests(files, runOptions = {}) {
  try {
    await access(join(repositoryRoot, contractPath));
  } catch (error) {
    if (error?.code === 'ENOENT') { return null; }
    throw error;
  }
  try {
    const contract = JSON.parse(await readFile(join(repositoryRoot, contractPath), 'utf8'));
    const { required } = validateNodeTestContract(contract);
    const selected = new Set(files.map((file) => relative(repositoryRoot, resolvePath(repositoryRoot, file)).split(sep).join('/')));
    if (![...required.values()].some((item) => selected.has(item.file))) { return null; }
    await runNodeTestExecution({ root: repositoryRoot, files, contractPath, runOptions });
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runUnadoptedNodeTests(files, flags = [], environment = process.env) {
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...flags, ...files], {
    cwd: repositoryRoot, env: environment, stdio: 'inherit',
  });
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTermination = () => child.kill('SIGTERM');
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardTermination);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0))));
    });
  } finally {
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTermination);
  }
}
