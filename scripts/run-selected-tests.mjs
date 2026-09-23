import { maybeRunMandatoryNodeTests, runUnadoptedNodeTests } from './mandatory-node-test.mjs';

if (process.argv.length < 3) { throw new Error('Selected test files are required.'); }
process.exitCode = await maybeRunMandatoryNodeTests(process.argv.slice(2)) ??
  await runUnadoptedNodeTests(process.argv.slice(2));
