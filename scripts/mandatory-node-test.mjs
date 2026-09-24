import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { join, relative, resolve as resolvePath, sep } from 'node:path';

import { runNodeTestExecution, validateNodeTestContract } from '../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.js';
import { repositoryRoot } from './check-test-manifests.mjs';

const contractPath = 'architecture/foundation/node-test-execution.json';

export async function maybeRunMandatoryNodeTests(files, runOptions = {}, root = repositoryRoot) {
  try {
    const contract = JSON.parse(await readFile(join(root, contractPath), 'utf8'));
    const { required } = validateNodeTestContract(contract);
    const requiredFiles = new Set([...required.values()].map((item) => item.file));
    const identity = ({ dev, ino }) => `${dev}:${ino}`;
    const adopted = new Map();
    for (const file of requiredFiles) {
      const key = identity(await stat(join(root, file), { bigint: true }));
      if (adopted.has(key) && adopted.get(key) !== file) {
        throw new Error(`mandatory contract aliases an adopted entry: ${file}`);
      }
      adopted.set(key, file);
    }
    let mandatorySelected = false;
    for (const file of files) {
      const path = relative(root, resolvePath(root, file)).split(sep).join('/');
      const adoptedFile = adopted.get(identity(await stat(resolvePath(root, file), { bigint: true })));
      if (adoptedFile !== undefined && adoptedFile !== path) {
        throw new Error(`selected file aliases an adopted entry: ${path}`);
      }
      mandatorySelected ||= adoptedFile !== undefined;
    }
    if (!mandatorySelected) { return null; }
    await runNodeTestExecution({ root, files, contractPath, runOptions });
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
