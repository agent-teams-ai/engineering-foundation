import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const M4 = Object.freeze({
  source: "d82ced4de8f1028bf674bf149b0c823a6ef9fc11",
  repository: "agent-teams-ai/docs-protocol-canary-20260817", repositoryId: "1336577313",
  from: "docs-2026-08-28-stable9.1", to: "docs-2026-09-10-stable18",
  controllerVersion: "0.2.4",
  controllerIntegrity: "sha512-RS8s0774n5uEptiNuQGC6J2xfMU3Y+ictjdZYxBxoTpP9KQOQgnoHdLm8RhKhwz/2EKnO4Rijk8kSZWAaEcUUw==",
  lockDigest: "sha256:2f4fb89fe7bd03af852272a260a2b6b56276c18c1dee2f6653eb4109c57f2500",
  closure: "sha256:e2c56ef5299a33d83e86279151e32eab0eb4ca19e020a02aa65d657cb3fa5054"
});
const profilePath = "architecture/foundation/docs-consumer-integration.json";
const lockFixture = new URL("../packages/docs-protocol-agent-teams/tests/fixtures/target-lockfile/candidate-target-lock.yaml", import.meta.url);
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export const qualificationProbe = `
import { observeDocsProtocolQualificationV3Lockfile } from '@agent-teams/docs-protocol-agent-teams/qualification';
const input = JSON.parse(process.argv[1]);
console.log(JSON.stringify(observeDocsProtocolQualificationV3Lockfile({
  profile: input.profile, lockfileBytes: Buffer.from(input.lockfileBase64, 'base64')
})));`;
export const barrierProbe = `
import { inspectKnownFileTransactionBarrier } from '@agent-teams/repository-mutation';
console.log(JSON.stringify(await inspectKnownFileTransactionBarrier({ consumerRoot: process.argv[1] })));`;

export function runDirectoryName(environment) {
  assert.equal(environment.GITHUB_ACTIONS, "true", "M4 runs only in a disposable hosted job");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    assert.match(environment[key] ?? "", /^[1-9][0-9]*$/u);
  }
  return `TEST-m4-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`;
}

export async function snapshot(root) {
  const entries = [];
  async function visit(prefix) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (entry.name === "node_modules" || (!prefix && [".git", ".agent-teams-local"].includes(entry.name))) {continue;}
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {await visit(path); continue;}
      assert.ok(entry.isFile(), `Nonregular source evidence: ${path}`);
      entries.push({ path, digest: sha256(await readFile(join(root, path))), mode: (await lstat(join(root, path))).mode & 0o777 });
    }
  }
  await visit("");
  return entries.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function selectedPostimage(preparation, path) {
  const matches = preparation.plan.operations.filter(operation => operation.path === path);
  assert.equal(matches.length, 1, `Exactly one selected image required: ${path}`);
  const image = matches[0].postimage;
  const bytes = Buffer.from(image.contentBase64, "base64");
  assert.equal(sha256(bytes), image.digest);
  return bytes;
}

function commandRunner(root, evidence) {
  let sequence = 0;
  return async (label, executable, args, cwd = root, expectedCode = 0) => {
    const result = await new Promise(resolve => {
      execFile(executable, args, { cwd, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GITHUB_REPOSITORY: M4.repository, GITHUB_REPOSITORY_ID: M4.repositoryId,
          NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" } }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : error.code ?? "process-error", stdout, stderr });
      });
    });
    await writeFile(join(evidence, `${String(++sequence).padStart(2, "0")}-${label}.json`),
      `${JSON.stringify({ executable, args, cwd, ...result }, null, 2)}\n`, { flag: "wx" });
    if (expectedCode === "failure") {assert.notEqual(result.code, 0, `${label} unexpectedly succeeded`);}
    else {assert.equal(result.code, expectedCode, `${label}: ${result.stderr.slice(-4000)} ${result.stdout.slice(-2000)}`);}
    return result.stdout.trim();
  };
}

async function installController(root, run) {
  const tooling = join(root, "controller");
  await mkdir(tooling);
  const archive = join(tooling, "controller.tgz");
  await run("controller-download", "curl", ["--fail", "--silent", "--show-error", "--max-filesize", "5242880",
    "--output", archive, "https://registry.npmjs.org/@agent-teams/docs-protocol-agent-teams/-/docs-protocol-agent-teams-0.2.4.tgz"]);
  assert.equal(`sha512-${createHash("sha512").update(await readFile(archive)).digest("base64")}`, M4.controllerIntegrity);
  await writeFile(join(tooling, "package.json"), '{"name":"test-m4-controller","private":true}\n', { flag: "wx" });
  await run("controller-install", "npm", ["install", "--ignore-scripts", "--package-lock=false", archive], tooling);
  const controller = await realpath(join(tooling, "node_modules/@agent-teams/docs-protocol-agent-teams"));
  assert.equal(JSON.parse(await readFile(join(controller, "package.json"))).version, M4.controllerVersion);
  return controller;
}

async function assertImages(root, operations, source) {
  for (const operation of operations) {
    assert.equal(operation.precondition.state, "known-file");
    assert.equal(operation.precondition.acceptedPreimages.length, 1);
    const image = source ? operation.precondition.acceptedPreimages[0] : operation.postimage;
    assert.deepEqual(await readFile(join(root, operation.path)), Buffer.from(image.contentBase64, "base64"));
    assert.equal((await lstat(join(root, operation.path))).mode & 0o777, image.mode);
  }
}

async function observeSelection(controller, preparation, evidence, run) {
  const profile = JSON.parse(selectedPostimage(preparation, profilePath));
  const bytes = selectedPostimage(preparation, "pnpm-lock.yaml");
  assert.equal(sha256(bytes), M4.lockDigest);
  assert.equal(profile.cohort.cohortId, M4.to);
  const expected = { docsProtocol: "0.6.0", docsProtocolAgentTeams: "0.2.3", engineeringFoundation: "1.1.1",
    documentAuthoring: "0.3.0", repositoryMutation: "0.2.0" };
  for (const [key, version] of Object.entries(expected)) {assert.equal(profile.cohort.packages[key].version, version);}
  const observed = JSON.parse(await run("selected-closure-probe", process.execPath,
    ["--input-type=module", "--eval", qualificationProbe, JSON.stringify({ profile, lockfileBase64: bytes.toString("base64") })], controller));
  assert.equal(observed.runtimeClosureDigest, M4.closure);
  assert.equal(profile.cohort.runtime.runtimeClosureDigest, M4.closure);
  await writeFile(join(evidence, "selected-closure.json"), `${JSON.stringify(observed)}\n`, { flag: "wx" });
}

async function lifecycle(root, evidence, run, controller) {
  const consumer = join(root, "consumer");
  await run("clone", "git", ["clone", "--no-hardlinks", `https://github.com/${M4.repository}.git`, consumer]);
  await run("source-checkout", "git", ["checkout", "--detach", M4.source], consumer);
  const manifest = JSON.parse(await readFile(join(consumer, "package.json")));
  assert.equal(manifest.packageManager, "pnpm@11.18.0");
  const source = await snapshot(consumer);
  const tree = await run("source-tree", "git", ["rev-parse", "HEAD^{tree}"], consumer);
  await writeFile(join(evidence, "source.json"), `${JSON.stringify({ revision: M4.source, tree, inventory: source })}\n`, { flag: "wx" });
  await run("source-install", "corepack", ["pnpm", "install", "--frozen-lockfile", "--package-import-method=copy",
    "--ignore-scripts", "--ignore-pnpmfile", "--verify-store-integrity"], consumer);
  assert.deepEqual(await snapshot(consumer), source);
  const historical = join(consumer, "node_modules/@agent-teams/docs-protocol/dist/cli.js");
  assert.equal(JSON.parse(await run("source-current", process.execPath, [historical, "consumer", "check", "--consumer", consumer, "--json"], consumer)).outcome, "current");
  const inspectBarrier = async label => JSON.parse(await run(`barrier-${label}`, process.execPath,
    ["--input-type=module", "--eval", barrierProbe, consumer], controller));
  assert.equal((await inspectBarrier("source")).state, "idle");
  const authority = await run("authority", "gh", ["api", "repos/agent-teams-ai/.github/commits/main", "--jq", ".sha"]);
  assert.match(authority, /^[a-f0-9]{40}$/u);
  const lock = await readFile(lockFixture);
  assert.equal(sha256(lock), M4.lockDigest);
  const selectedPath = join(evidence, "target-lock.yaml"), badPath = join(evidence, "tampered-lock.yaml");
  await writeFile(selectedPath, lock, { flag: "wx" });
  await writeFile(badPath, Buffer.concat([lock, Buffer.from("\n# tampered\n")]), { flag: "wx" });
  const proofPath = join(evidence, "restoration.json"), cli = join(controller, "dist/cli.js");
  const prepare = lockPath => [cli, "upgrade", "--consumer", consumer, "--to", M4.to, "--authority-revision", authority,
    "--source-generation", "1", "--target-generation", "2", "--restoration-proof", proofPath, "--prepare",
    "--target-lockfile", lockPath, "--target-lockfile-sha256", M4.lockDigest, "--json"];
  const denied = JSON.parse(await run("tampered-refusal", process.execPath, prepare(badPath), consumer, "failure"));
  assert.match(JSON.stringify(denied), /SHA256/u);
  assert.deepEqual(await snapshot(consumer), source);
  for (const path of [proofPath, `${proofPath}.prepared`, `${proofPath}.receipt`]) {
    await assert.rejects(lstat(path), { code: "ENOENT" });
  }
  assert.equal((await inspectBarrier("tampered-refusal")).state, "idle");
  const prepared = JSON.parse(await run("prepare", process.execPath, prepare(selectedPath), consumer));
  assert.equal(prepared.outcome, "prepared");
  assert.equal(prepared.preparation.path, `${proofPath}.prepared`);
  const preparedBytes = await readFile(prepared.preparation.path);
  assert.equal(sha256(preparedBytes), prepared.preparation.digest);
  const preparation = JSON.parse(preparedBytes);
  assert.equal(preparation.sourceRevision, M4.source);
  assert.equal(preparation.sourceTree, tree);
  assert.equal(preparation.controller.version, M4.controllerVersion);
  assert.equal(preparation.kernel.version, "0.2.0");
  await assertImages(consumer, preparation.plan.operations, true);
  await observeSelection(controller, preparation, evidence, run);
  assert.deepEqual(await snapshot(consumer), source);
  const finalized = JSON.parse(await run("finalize", process.execPath, [cli, "finalize", "--consumer", consumer,
    "--from", M4.from, "--to", M4.to, "--source-generation", "1", "--target-generation", "2",
    "--preparation", prepared.preparation.path, "--expect", prepared.preparation.digest, "--proof", proofPath, "--json"], consumer));
  assert.equal(finalized.outcome, "upgraded");
  assert.equal(finalized.receipt.planDigest, preparation.plan.planDigest);
  assert.ok(finalized.receipt.operations.every(operation => operation.outcome === "replaced"));
  await assertImages(consumer, preparation.plan.operations, false);
  assert.equal(sha256(await readFile(join(consumer, "pnpm-lock.yaml"))), M4.lockDigest);
  await verifyTarget(consumer, run);
  const proof = JSON.parse(await readFile(proofPath));
  assert.equal(sha256(await readFile(proofPath)), finalized.restoration.digest);
  assert.deepEqual(proof.controller, preparation.controller);
  assert.deepEqual(proof.kernel, preparation.kernel);
  const restored = JSON.parse(await run("restore", process.execPath, [cli, "restore", "--consumer", consumer,
    "--from", M4.to, "--to", M4.from, "--source-generation", "2", "--target-generation", "1",
    "--proof", proofPath, "--expect", finalized.restoration.digest, "--json"], consumer));
  assert.equal(restored.outcome, "restored");
  await assertImages(consumer, preparation.plan.operations, true);
  assert.deepEqual(await snapshot(consumer), source);
  assert.equal(await run("restored-head", "git", ["rev-parse", "HEAD"], consumer), M4.source);
  assert.equal(await run("restored-tree", "git", ["rev-parse", "HEAD^{tree}"], consumer), tree);
  assert.equal(JSON.parse(await run("restored-current", process.execPath, [historical, "consumer", "check", "--consumer", consumer, "--json"], consumer)).outcome, "current");
  const barrier = await inspectBarrier("restored");
  assert.equal(barrier.state, "idle");
  await writeFile(join(evidence, "result.json"), `${JSON.stringify({ outcome: "passed", source: M4.source, tree,
    closure: M4.closure, lockDigest: M4.lockDigest, controller: proof.controller, kernel: proof.kernel,
    preparationDigest: prepared.preparation.digest, restorationDigest: finalized.restoration.digest, barrier,
    foundationChecks: ["assert-dev-only", "assert-registry"], inventoryRestored: true })}\n`, { flag: "wx" });
}

export async function installedPackageVersion(consumer, name) {
  const modules = join(consumer, "node_modules/@agent-teams");
  let path = join(modules, name, "package.json");
  if (name === "document-authoring" || name === "repository-mutation") {
    const owner = name === "document-authoring" ? "docs-protocol" : "docs-protocol-agent-teams";
    const require = createRequire(await realpath(join(modules, owner, "package.json")));
    path = require.resolve(`@agent-teams/${name}/package.json`);
  }
  return JSON.parse(await readFile(path)).version;
}

async function verifyTarget(consumer, run) {
  const modules = join(consumer, "node_modules/@agent-teams");
  for (const [name, version] of Object.entries({ "docs-protocol": "0.6.0", "docs-protocol-agent-teams": "0.2.3",
    "engineering-foundation": "1.1.1", "document-authoring": "0.3.0", "repository-mutation": "0.2.0" })) {
    assert.equal(await installedPackageVersion(consumer, name), version);
  }
  assert.equal(JSON.parse(await run("target-current", process.execPath,
    [join(modules, "docs-protocol-agent-teams/dist/cli.js"), "check", "--consumer", consumer, "--json"], consumer)).outcome, "current");
  for (const command of ["assert-dev-only", "assert-registry"]) {
    await run(`foundation-${command}`, process.execPath,
      [join(modules, "engineering-foundation/dist/cli.js"), command, "--consumer", consumer], consumer);
  }
}

export async function main() {
  assert.equal(process.platform, "linux", "M4 hosted lifecycle uses Linux durability semantics");
  const root = join(await realpath(process.env.RUNNER_TEMP), runDirectoryName(process.env));
  await mkdir(root); // Exclusive fresh allocation. Never reuse or clean an earlier attempt.
  const evidence = join(root, "evidence");
  await mkdir(evidence);
  const run = commandRunner(root, evidence);
  try {await lifecycle(root, evidence, run, await installController(root, run));}
  catch (error) {
    await writeFile(join(evidence, "failure.json"), `${JSON.stringify({ message: error.message, stack: error.stack })}\n`, { flag: "wx" });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {await main();}
