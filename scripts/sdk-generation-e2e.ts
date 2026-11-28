import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { compareGeneratedSdkDirectories } from "../packages/engineering-foundation/dist/capabilities/contract-protobuf-evolution/qualification/module.js";

// This explicit fixture uses the reviewed consumer's own local generator and
// output inventory. It does not load consumer code into the ordinary checker.
const generateFixture = `
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  contractRoot, generateContractFiles, generatedArtifactPaths, verifyContractTools
} from "./tools/contract-generation.ts";
const [stage, expected] = process.argv.slice(1);
await verifyContractTools();
await generateContractFiles(stage);
for (const path of generatedArtifactPaths) {
  const destination = join(expected, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(contractRoot, path), destination, { errorOnExist: true, force: false });
}
`;

const execute = promisify(execFile);
const identityPath = process.argv[2];
assert.ok(identityPath, "Pass the provisioned, pinned Identity fixture checkout.");
const identityRoot = resolve(identityPath);
const contractRoot = join(identityRoot, "packages", "contracts");

async function generate(root: string) {
  const stage = join(root, "stage");
  const expectedRoot = join(root, "expected");
  const regeneratedRoot = join(root, "regenerated");
  for (const directory of [stage, expectedRoot, regeneratedRoot]) {
    await mkdir(directory);
  }
  for (const path of ["proto", "buf.yaml", "buf.gen.yaml"]) {
    await cp(join(contractRoot, path), join(stage, path), { recursive: true });
  }
  await execute(
    process.execPath,
    ["--input-type=module", "--eval", generateFixture, stage, expectedRoot],
    { cwd: identityRoot, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
  for (const path of ["gen", "src"]) {
    await cp(join(stage, path), join(regeneratedRoot, path), { recursive: true });
  }
  return { expectedRoot, regeneratedRoot };
}

const root = await mkdtemp(join(tmpdir(), "foundation-native-sdk-"));
try {
  const input = await generate(root);
  const clean = await compareGeneratedSdkDirectories(input);
  assert.deepEqual(
    [clean.missingPaths, clean.unexpectedPaths, clean.changedPaths],
    [[], [], []],
  );
  assert.equal(
    clean.generationDrift.expectedGeneratedOutputDigest,
    clean.generationDrift.observedGeneratedOutputDigest,
  );
  const changedPath = "gen/go/identity/v1/identity.pb.go";
  await appendFile(join(input.regeneratedRoot, changedPath), "\n// changed qualification fixture\n");
  const drift = await compareGeneratedSdkDirectories(input);
  assert.deepEqual(drift.changedPaths, [changedPath]);
  assert.notEqual(
    drift.generationDrift.expectedGeneratedOutputDigest,
    drift.generationDrift.observedGeneratedOutputDigest,
  );
  process.stdout.write("Native Identity TypeScript/Go SDK generation and drift comparison passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
