import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { mandatoryTestFile, writeMandatoryGateFixture } from "./mandatory-node-test-gate-fixture.mjs";
import { runCommand } from "./pack-test-support.mjs";

/** Exercise mandatory test admission through the verified registry installation. */
export async function verifyRegistryMandatoryNodeTests({ consumerRoot, installedRoot }) {
  const physicalConsumer = await realpath(consumerRoot);
  const physicalFoundation = await realpath(installedRoot);
  assert.equal(physicalFoundation, await realpath(join(
    physicalConsumer, "node_modules/@agent-teams/engineering-foundation",
  )), "Mandatory test fixture must use the verified registry installation");
  const gateCli = join(physicalFoundation, "dist/cli.js");
  const nodeTestCli = join(physicalFoundation, "dist/node-test-cli.js");
  await Promise.all([readFile(gateCli), readFile(nodeTestCli)]);
  const root = await mkdtemp(join(physicalConsumer, "mandatory-node-test-"));
  const requiredCase = { file: mandatoryTestFile, names: ["required"], kind: "test" };
  const runCase = async ({ source, expected, exceptions = [] }) => {
    await writeMandatoryGateFixture({
      root, commandPath: nodeTestCli, source, required: [requiredCase], exceptions,
    });
    let result;
    try {
      result = { code: 0, ...await runCommand(process.execPath,
        [gateCli, "gate", "run", "verify", "--consumer", root, "--format", "json"], root) };
    } catch (error) { result = error; }
    assert.equal(result.code, expected, result.stdout || result.stderr || result.message);
  };
  await runCase({ source: "import test from 'node:test'; test('required', () => {});", expected: 0 });
  await runCase({ source: "import test from 'node:test'; test.skip('required', () => {});", expected: 1 });
  await runCase({ source: "import test from 'node:test'; test('unrelated', () => {});", expected: 1 });
  await runCase({
    source: "import test from 'node:test'; test.skip('required', () => {});",
    expected: 0,
    exceptions: [{ ...requiredCase, status: "skipped",
      reason: "Reviewed platform-only fixture exception for the exact required case.",
      applicability: { platforms: [process.platform] } }],
  });
}
