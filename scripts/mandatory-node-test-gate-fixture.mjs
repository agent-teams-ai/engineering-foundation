import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const mandatoryTestFile = 'cases.test.mjs';

// The built test and registry-installed qualification use the same consumer
// contract. The command path is always the actual package entry under test.
export async function writeMandatoryGateFixture({ root, commandPath, source, required, exceptions = [] }) {
  await mkdir(join(root, 'architecture/foundation'), { recursive: true });
  await writeFile(join(root, mandatoryTestFile), source);
  await writeFile(join(root, 'contract.json'), JSON.stringify({ schemaVersion: 1, required, exceptions }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'mandatory-node-test-fixture', private: true,
    scripts: { mandatory: `node ${JSON.stringify(commandPath)} --contract contract.json -- ${mandatoryTestFile}` },
  }));
  await writeFile(join(root, 'foundation.config.yaml'), 'schemaVersion: 1\nproject:\n  id: mandatory-node-test-fixture\ncapabilities:\n  quality.gate-runner:\n    configPath: architecture/foundation/quality-gates.yaml\n');
  await writeFile(join(root, 'architecture/foundation/quality-gates.yaml'), 'schemaVersion: 1\npackageManager: pnpm\nprofiles:\n  - id: verify\n    concurrency: 1\n    tasks:\n      - id: mandatory\n');
}
