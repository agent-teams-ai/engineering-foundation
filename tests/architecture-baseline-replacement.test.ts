import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import { acquireMutationLease, observeAtomicFileReplacement, releaseMutationLease } from "../packages/repository-mutation/dist/node.js";
import { RepositoryMutationError } from "../packages/repository-mutation/dist/coordination.js";
import { baselineReplacementOperations, type BaselineReplacementOperations } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/architecture-decision-baseline-replacement.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { parseAcceptedArchitectureDecisionBaseline } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/application/policies/accepted-architecture-decision-baseline.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../packages/engineering-foundation/dist/source-inventory/node.js";

const observation = { read: readContainedRegularFile, pathTraversesSymbolicLink };
const fixtureRoot = fileURLToPath(new URL("./fixtures/governance-architecture-decisions/valid", import.meta.url));
const repositoryPath = "architecture/decisions/accepted-decisions.json";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-atomic-baseline-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtureRoot, root, { recursive: true });
  await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Atomic ADR baseline qualification.\n");
  const repository = new FilesystemArchitectureDecisionBaselineRepository(observation);
  const input = { consumerRoot: root, path: repositoryPath };
  const current = await repository.read(input);
  assert.equal(current.kind, "valid");
  if (current.kind !== "valid") { throw new Error("Fixture baseline was not valid."); }
  const baseline = parseAcceptedArchitectureDecisionBaseline(current.value);
  assert.ok(baseline);
  const next = { ...baseline, decisions: baseline.decisions.map((entry, index) => index === 0
    ? { ...entry, immutableDigest: `sha256:${"a".repeat(64)}` } : entry) };
  return { root, repository, path: join(root, repositoryPath),
    write: { ...input, baseline: next, expected: { kind: "valid" as const, revision: current.revision } } };
}

function failures(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

function hasCode(error: unknown, code: string): boolean {
  return failures(error).some((failure) => failure instanceof CapabilityInputError && failure.problem.code === code);
}

async function temporaries(path: string): Promise<string[]> {
  return (await readdir(dirname(path))).filter((name) => name.startsWith(".foundation-atomic-replacement-"));
}

test("the public mutation resource rejects unsafe paths and repeated temporary preparation", async t => {
  const current = await fixture(t);
  for (const candidate of ["relative.json", join(current.root, "../outside.json")]) {
    await assert.rejects(() => observeAtomicFileReplacement({ root: current.root, candidate }),
      { name: "NodeAtomicFileReplacementError", failure: "unsafe-directory" });
  }
  const replacement = await observeAtomicFileReplacement({ root: current.root, candidate: current.path });
  const lease = await acquireMutationLease(current.root);
  try {
    await replacement.bindParent();
    await replacement.prepare(Buffer.from("first owned temporary\n"));
    await assert.rejects(() => replacement.prepare(Buffer.from("second temporary\n")), /one temporary preparation/u);
    assert.equal((await temporaries(current.path)).length, 1);
    await replacement.cleanup();
    assert.deepEqual(await temporaries(current.path), []);
  } finally { await replacement.cleanup(); await releaseMutationLease(lease); }
});

test("ADR replacement uses a sibling temporary and the existing root lease", async t => {
  const current = await fixture(t);
  let observedTemporary = "";
  const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
    ...baselineReplacementOperations,
    async openTemporary(path) {
      observedTemporary = path;
      assert.equal(dirname(path), dirname(current.path));
      await assert.rejects(() => acquireMutationLease(current.root), /Another repository mutation operation/u);
      return baselineReplacementOperations.openTemporary(path);
    },
  });
  assert.equal(await repository.write(current.write), "updated");
  assert.ok(observedTemporary);
  assert.deepEqual(await temporaries(current.path), []);
  assert.deepEqual(JSON.parse(await readFile(current.path, "utf8")), current.write.baseline);
  // Root-lock terminal retirement remains permitted; it is not an active lease.
  const lease = await acquireMutationLease(current.root);
  await releaseMutationLease(lease);
});

test("a held root lease rejects ADR replacement without modifying its baseline", async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  const lease = await acquireMutationLease(current.root);
  try {
    await assert.rejects(() => current.repository.write(current.write), error =>
      hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_LOCK_UNAVAILABLE"));
    assert.deepEqual(await readFile(current.path), before);
  } finally { await releaseMutationLease(lease); }
  assert.equal(await current.repository.write(current.write), "updated");
});

test("ADR temporary creation cannot overwrite an existing sibling", async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  const foreign = Buffer.from("preexisting sibling bytes\n");
  let temporary = "";
  const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
    ...baselineReplacementOperations, async openTemporary(path) {
      temporary = path;
      await writeFile(path, foreign, { flag: "wx" });
      return baselineReplacementOperations.openTemporary(path);
    },
  });
  await assert.rejects(() => repository.write(current.write), { code: "EEXIST" });
  assert.deepEqual(await readFile(current.path), before);
  assert.deepEqual(await readFile(temporary), foreign);
});

test("common mutation evidence blocks ADR promotion and retains its recovery barrier", async t => {
  const current = await fixture(t);
  const stateDirectory = join(current.root, ".agent-teams-local");
  await mkdir(stateDirectory);
  const evidence = join(stateDirectory, "scaffolding-transaction.json");
  const evidenceBytes = Buffer.from("foreign transaction evidence\n");
  await writeFile(evidence, evidenceBytes);
  const before = await readFile(current.path);
  await assert.rejects(() => current.repository.write(current.write), error =>
    hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"));
  assert.deepEqual(await readFile(evidence), evidenceBytes);
  assert.deepEqual(await readFile(current.path), before);
  const barrier = JSON.parse(await readFile(join(stateDirectory, "foundation-operation.lock"), "utf8")) as { kind: string };
  assert.equal(barrier.kind, "transaction-barrier");
});

for (const timing of ["before-rename", "before-release"] as const) {
  test(`ADR promotion rechecks common mutation evidence ${timing}`, async t => {
    const current = await fixture(t);
    const before = await readFile(current.path);
    const state = join(current.root, ".agent-teams-local");
    const evidence = join(state, "scaffolding-transaction.json");
    const bytes = Buffer.from("new foreign mutation evidence\n");
    let reads = 0;
    const repository = new FilesystemArchitectureDecisionBaselineRepository({
      pathTraversesSymbolicLink,
      async read(input) {
        const source = await readContainedRegularFile(input);
        if (++reads === 3 && timing === "before-rename") { await writeFile(evidence, bytes); }
        return source;
      },
    }, { ...baselineReplacementOperations, async syncParent(parent) {
      if (timing === "before-release") { await writeFile(evidence, bytes); }
      await baselineReplacementOperations.syncParent(parent);
    } });
    if (timing === "before-rename") {
      await assert.rejects(() => repository.write(current.write), error =>
        hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"));
      assert.deepEqual(await readFile(current.path), before);
    } else {
      assert.equal(await repository.write(current.write), "updated");
      assert.deepEqual(JSON.parse(await readFile(current.path, "utf8")), current.write.baseline);
    }
    assert.deepEqual(await readFile(evidence), bytes);
    assert.equal((JSON.parse(await readFile(join(state, "foundation-operation.lock"), "utf8")) as { kind: string }).kind, "transaction-barrier");
  });
}

for (const phase of ["writeFile", "sync", "close"] as const) {
  test(`ADR pre-rename ${phase} failure retains original bytes and safely retires its owned temporary`, async t => {
    const current = await fixture(t);
    const before = await readFile(current.path);
    const failure = new Error(`injected ${phase} failure`);
    const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
      ...baselineReplacementOperations,
      async openTemporary(path) {
        const handle = await baselineReplacementOperations.openTemporary(path);
        if (phase === "close") {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); throw failure; };
        } else { handle[phase] = async () => { throw failure; }; }
        return handle;
      },
    });
    await assert.rejects(() => repository.write(current.write), error => error === failure);
    assert.deepEqual(await readFile(current.path), before);
    assert.deepEqual(await temporaries(current.path), []);
    assert.ok((await readdir(dirname(current.path))).includes(".foundation-retired-evidence-"));
    const lease = await acquireMutationLease(current.root);
    await releaseMutationLease(lease);
  });
}

test("ADR failures preserve write, close, cleanup and lease-release errors together", async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  const expected = ["write", "close", "cleanup", "release"].map(phase => new Error(`${phase} failed`));
  const [writeFailure, closeFailure, cleanupFailure, releaseFailure] = expected;
  const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
    ...baselineReplacementOperations,
    async openTemporary(path) {
      const handle = await baselineReplacementOperations.openTemporary(path);
      const close = handle.close.bind(handle);
      handle.writeFile = async () => { throw writeFailure; };
      handle.close = async () => { await close(); throw closeFailure; };
      return handle;
    },
    async cleanupTemporary(replacement) {
      await baselineReplacementOperations.cleanupTemporary(replacement);
      throw cleanupFailure;
    },
    async releaseLease(lease) { await releaseMutationLease(lease); throw releaseFailure; },
  });
  await assert.rejects(() => repository.write(current.write), error => {
    assert.deepEqual(failures(error), expected);
    return true;
  });
  assert.deepEqual(await readFile(current.path), before);
  assert.deepEqual(await temporaries(current.path), []);
});

test("ADR cancellation after writing the temporary preserves its baseline and releases its lease", async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  const controller = new AbortController();
  const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
    ...baselineReplacementOperations, async openTemporary(path) {
      const handle = await baselineReplacementOperations.openTemporary(path);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); controller.abort(); };
      return handle;
    },
  });
  await assert.rejects(() => repository.write({ ...current.write, signal: controller.signal }), error =>
    hasCode(error, "EXECUTION_CANCELLED"));
  assert.deepEqual(await readFile(current.path), before);
  assert.deepEqual(await temporaries(current.path), []);
  const lease = await acquireMutationLease(current.root);
  await releaseMutationLease(lease);
});

for (const completed of [false, true]) {
  test(`ADR rename failure preserves its actual ${completed ? "committed" : "uncommitted"} state`, async t => {
    const current = await fixture(t);
    const before = await readFile(current.path);
    const failure = new Error("rename failed");
    const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
      ...baselineReplacementOperations, async rename(source, target) {
        if (completed) { await baselineReplacementOperations.rename(source, target); }
        throw failure;
      },
    });
    await assert.rejects(() => repository.write(current.write), error => error === failure);
    if (completed) { assert.deepEqual(JSON.parse(await readFile(current.path, "utf8")), current.write.baseline); }
    else { assert.deepEqual(await readFile(current.path), before); }
    assert.deepEqual(await temporaries(current.path), []);
  });
}

for (const phase of ["syncParent", "releaseLease"] as const) {
  test(`ADR post-rename ${phase} failure may leave replacement committed`, async t => {
    const current = await fixture(t);
    const failure = new Error(`${phase} failed after rename`);
    const operations: BaselineReplacementOperations = phase === "syncParent"
      ? { ...baselineReplacementOperations, syncParent: async () => { throw failure; } }
      : { ...baselineReplacementOperations, releaseLease: async lease => {
        await releaseMutationLease(lease);
        throw failure;
      } };
    const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, operations);
    await assert.rejects(() => repository.write(current.write), error => error === failure);
    assert.deepEqual(JSON.parse(await readFile(current.path, "utf8")), current.write.baseline);
    // The stale expected revision cannot be reused blindly after an error.
    await assert.rejects(() => current.repository.write(current.write), error =>
      hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"));
  });
}

for (const syncFailure of [false, true]) {
  test("ADR post-rename root substitution retains its barrier and all finalization failures: " + syncFailure, async t => {
    const current = await fixture(t);
    const original = current.root + "-original";
    t.after(() => rm(original, { force: true, recursive: true }));
    const failure = new Error("sync failed after root substitution");
    const repository = new FilesystemArchitectureDecisionBaselineRepository(observation, {
      ...baselineReplacementOperations,
      async syncParent(parent) {
        await baselineReplacementOperations.syncParent(parent);
        await rename(current.root, original);
        await symlink(original, current.root, process.platform === "win32" ? "junction" : "dir");
        if (syncFailure) { throw failure; }
      },
    });
    await assert.rejects(() => repository.write(current.write), error => {
      assert.ok(failures(error).some(entry => entry instanceof RepositoryMutationError && entry.code === "MUTATION_LEASE_INVALID"));
      if (syncFailure) { assert.ok(failures(error).includes(failure)); }
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(join(original, repositoryPath), "utf8")), current.write.baseline);
    const barrier = JSON.parse(await readFile(join(original, ".agent-teams-local", "foundation-operation.lock"), "utf8")) as { kind: string };
    assert.equal(barrier.kind, "transaction-barrier");
  });
}

test("ADR temporary substitution preserves foreign bytes and refuses replacement", async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  let temporary = "";
  let reads = 0;
  const foreign = Buffer.from("another writer's bytes\n");
  const repository = new FilesystemArchitectureDecisionBaselineRepository({
    pathTraversesSymbolicLink,
    async read(input) {
      const bytes = await readContainedRegularFile(input);
      if (++reads === 3) {
        await rename(temporary, `${temporary}.saved-owned`);
        await writeFile(temporary, foreign, { flag: "wx" });
      }
      return bytes;
    },
  }, { ...baselineReplacementOperations, async openTemporary(path) {
    temporary = path;
    return baselineReplacementOperations.openTemporary(path);
  } });
  await assert.rejects(() => repository.write(current.write), error =>
    hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_TEMPORARY_CHANGED"));
  assert.deepEqual(await readFile(current.path), before);
  assert.deepEqual(await readFile(temporary), foreign);
});

test("ADR replacement rejects a root replaced after its initial preimage observation", async t => {
  const current = await fixture(t);
  const retired = `${current.root}-original`;
  t.after(() => rm(retired, { recursive: true, force: true }));
  const before = await readFile(current.path);
  let reads = 0;
  const repository = new FilesystemArchitectureDecisionBaselineRepository({
    pathTraversesSymbolicLink,
    async read(input) {
      const bytes = await readContainedRegularFile(input);
      if (++reads === 1) {
        await rename(current.root, retired);
        await cp(fixtureRoot, current.root, { recursive: true });
      }
      return bytes;
    },
  });
  await assert.rejects(() => repository.write(current.write), error =>
    hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"));
  assert.deepEqual(await readFile(current.path), before);
  assert.deepEqual(await readFile(join(retired, repositoryPath)), before);
});

test("ADR replacement rejects a substituted parent without deleting either tree's temporary", async t => {
  const current = await fixture(t);
  const parent = dirname(current.path);
  const retired = `${parent}-original`;
  const before = await readFile(current.path);
  let reads = 0;
  let temporary = "";
  const foreign = Buffer.from("foreign sibling temporary\n");
  const repository = new FilesystemArchitectureDecisionBaselineRepository({
    pathTraversesSymbolicLink,
    async read(input) {
      const bytes = await readContainedRegularFile(input);
      if (++reads === 3) {
        await rename(parent, retired);
        await mkdir(parent);
        await writeFile(current.path, before);
        await writeFile(temporary, foreign);
      }
      return bytes;
    },
  }, { ...baselineReplacementOperations, async openTemporary(path) {
    temporary = path;
    return baselineReplacementOperations.openTemporary(path);
  } });
  await assert.rejects(() => repository.write(current.write), error =>
    hasCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"));
  assert.deepEqual(await readFile(current.path), before);
  assert.deepEqual(await readFile(temporary), foreign);
  assert.deepEqual(JSON.parse(await readFile(join(retired, basename(temporary)), "utf8")), current.write.baseline);
});

test("ADR promotion safely recovers the existing root lease after its holder is interrupted", async t => {
  const current = await fixture(t);
  const module = new URL("../packages/repository-mutation/dist/node.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireMutationLease } from ${JSON.stringify(module)};
    await acquireMutationLease(${JSON.stringify(current.root)});
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  const [ready] = await once(child.stdout, "data");
  assert.match(String(ready), /ready/u);
  const exit = once(child, "exit");
  child.kill();
  await exit;
  assert.equal(await current.repository.write(current.write), "updated");
  assert.deepEqual(JSON.parse(await readFile(current.path, "utf8")), current.write.baseline);
});

test("an interrupted ADR temporary write leaves the baseline intact and permits a fresh promotion", async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  const adapter = new URL("../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/", import.meta.url).href;
  const inventory = new URL("../packages/engineering-foundation/dist/source-inventory/node.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { FilesystemArchitectureDecisionBaselineRepository } from ${JSON.stringify(`${adapter}filesystem-architecture-decision-baseline-repository.js`)};
    import { baselineReplacementOperations } from ${JSON.stringify(`${adapter}architecture-decision-baseline-replacement.js`)};
    import { pathTraversesSymbolicLink, readContainedRegularFile } from ${JSON.stringify(inventory)};
    const repository = new FilesystemArchitectureDecisionBaselineRepository({ read: readContainedRegularFile, pathTraversesSymbolicLink }, {
      ...baselineReplacementOperations,
      async openTemporary(path) {
        const handle = await baselineReplacementOperations.openTemporary(path);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          process.stdout.write('ready\\n');
          await new Promise(() => {});
        };
        return handle;
      }
    });
    setInterval(() => {}, 1000);
    await repository.write(${JSON.stringify(current.write)});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  const [ready] = await once(child.stdout, "data");
  assert.match(String(ready), /ready/u);
  const exit = once(child, "exit");
  child.kill();
  await exit;
  assert.deepEqual(await readFile(current.path), before);
  const residual = await temporaries(current.path);
  assert.equal(residual.length, 1);
  assert.equal(await current.repository.write(current.write), "updated");
  assert.deepEqual(await temporaries(current.path), residual);
  assert.deepEqual(JSON.parse(await readFile(current.path, "utf8")), current.write.baseline);
});

test("ADR permission refusal is exercised by a process subject to directory permissions", {
  skip: process.platform === "win32" ? "POSIX permission bits do not establish Windows ACL refusal." : false,
}, async t => {
  const current = await fixture(t);
  const before = await readFile(current.path);
  await chmod(current.root, 0o777);
  await chmod(dirname(current.path), 0o555);
  // The source checkout can live under a private parent. Copy only built package
  // bytes into this disposable readable fixture; do not relax workspace access.
  const runtime = join(current.root, "permission-runtime");
  const foundation = join(runtime, "foundation");
  const mutation = join(runtime, "node_modules/@agent-teams/repository-mutation");
  for (const [name, destination] of [["engineering-foundation", foundation], ["repository-mutation", mutation]]) {
    assert.ok(name && destination);
    await mkdir(destination, { recursive: true });
    const source = fileURLToPath(new URL(`../packages/${name}/`, import.meta.url));
    await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
    await cp(join(source, "package.json"), join(destination, "package.json"));
  }
  const adapter = pathToFileURL(join(foundation, "dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/architecture-decision-baseline-replacement.js")).href;
  const inventory = pathToFileURL(join(foundation, "dist/source-inventory/node.js")).href;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { createHash } from 'node:crypto';
      import { mkdir } from 'node:fs/promises';
      import { observeAtomicFileReplacement } from '@agent-teams/repository-mutation/node';
      import { baselineReplacementOperations, replaceArchitectureDecisionBaseline } from ${JSON.stringify(adapter)};
      import { pathTraversesSymbolicLink, readContainedRegularFile } from ${JSON.stringify(inventory)};
      const root = ${JSON.stringify(current.root)}, candidate = ${JSON.stringify(current.path)}, parent = ${JSON.stringify(dirname(current.path))};
      try {
        await replaceArchitectureDecisionBaseline({
          expected: ${JSON.stringify(current.write.expected)}, source: ${JSON.stringify(`${JSON.stringify(current.write.baseline)}\n`)},
          target: { root, candidate, parent, replacement: await observeAtomicFileReplacement({ root, candidate }) },
          ensureParent: () => mkdir(parent, { recursive: true }),
          pathTraversesSymbolicLink: () => pathTraversesSymbolicLink(root, candidate),
          inspect: async () => {
            const source = (await readContainedRegularFile({ root, candidate, maxBytes: 4194304 })).toString('utf8');
            return { source, result: { kind: 'valid', revision: 'sha256:' + createHash('sha256').update(source).digest('hex'), value: JSON.parse(source) } };
          }
        }, baselineReplacementOperations);
        process.exitCode = 1;
      } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, problem: error.problem })); }
    `], { cwd: runtime, encoding: "utf8", ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}) });
    assert.equal(child.status, 0, child.stderr);
    assert.equal((JSON.parse(child.stdout) as { code: string }).code, "EACCES");
    assert.deepEqual(await readFile(current.path), before);
    assert.deepEqual(await temporaries(current.path), []);
  } finally { await chmod(dirname(current.path), 0o755); }
});
