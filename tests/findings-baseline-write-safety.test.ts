import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireMutationLease,
  releaseMutationLease,
} from "../packages/repository-mutation/dist/node.js";
import { RepositoryMutationError } from "../packages/repository-mutation/dist/coordination.js";
import { FilesystemFindingsBaselineStore } from "../packages/engineering-foundation/dist/capabilities/findings-baseline/adapters/outbound/filesystem/filesystem-findings-baseline-store.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import {
  pathTraversesSymbolicLink,
  readContainedRegularFile,
} from "../packages/engineering-foundation/dist/source-inventory/node.js";

const observation = { read: readContainedRegularFile, pathTraversesSymbolicLink };
const original = '{"findingsBaseline":1}\n{"path":"src/a.ts","rule":"oxlint/example","count":3}\n';
const smaller = original.replace('"count":3', '"count":1');
const larger = original.replace('"count":3', '"count":2');

async function fixture(t: TestContext, path = "architecture/findings.jsonl") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-findings-write-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, path);
  await mkdir(dirname(candidate), { recursive: true });
  await writeFile(candidate, original);
  return { root, path, candidate, store: new FilesystemFindingsBaselineStore(observation) };
}

function failures(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

function hasCode(error: unknown, code: string): boolean {
  return failures(error).some(
    (entry) => entry instanceof CapabilityInputError && entry.problem.code === code,
  );
}

async function temporaries(candidate: string): Promise<string[]> {
  return (await readdir(dirname(candidate))).filter((name) =>
    name.startsWith(".foundation-atomic-replacement-"),
  );
}

async function assertReleased(root: string): Promise<void> {
  const lease = await acquireMutationLease(root);
  await releaseMutationLease(lease);
}

function writer(t: TestContext, current: Awaited<ReturnType<typeof fixture>>, text: string) {
  const child = fork(
    fileURLToPath(new URL("./support/findings-baseline-writer.ts", import.meta.url)),
    [current.root, current.path, text, original],
    { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const first = Promise.withResolvers<string>();
  const result = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("message", (message) => {
    if (typeof message !== "string") {
      return;
    }
    first.resolve(message);
    if (message !== "read") {
      result.resolve(message);
    }
  });
  child.on("error", (error) => {
    first.reject(error);
    result.reject(error);
  });
  child.on("close", (code) => {
    const error = new Error(`Baseline writer closed (${code}): ${stderr}`);
    first.reject(error);
    result.reject(error);
    closed.resolve();
  });
  const deadline = setTimeout(() => {
    const error = new Error("Baseline writer exceeded its bounded fixture lifetime.");
    first.reject(error);
    result.reject(error);
    child.kill("SIGKILL");
  }, 20_000);
  // Both outcomes may reject before the caller reaches its next barrier.
  void first.promise.catch(() => {});
  void result.promise.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed.promise;
    clearTimeout(deadline);
  });
  return {
    first: first.promise,
    result: result.promise,
    closed: closed.promise,
    resume: () => child.send("continue"),
  };
}

for (const path of ["findings.jsonl", "architecture/findings.jsonl"]) {
  test(`ordinary findings replacement owns its temporary and releases its lease: ${path}`, async (t) => {
    const current = await fixture(t, path);
    await current.store.replace(current.root, path, smaller, original);
    assert.equal(await readFile(current.candidate, "utf8"), smaller);
    assert.deepEqual(await temporaries(current.candidate), []);
    await assertReleased(current.root);
  });
}

test("a pre-existing PID temporary survives the findings write", async (t) => {
  const current = await fixture(t);
  const foreign = `${current.candidate}.${process.pid}.tmp`;
  await writeFile(foreign, "another operation's bytes", { flag: "wx" });
  const outcome = await current.store.replace(current.root, current.path, smaller, original).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(await readFile(foreign, "utf8"), "another operation's bytes");
  assert.equal(outcome, null);
  assert.equal(await readFile(current.candidate, "utf8"), smaller);
});

test("two real findings writers cannot raise a completed prune", { timeout: 30_000 }, async (t) => {
  const current = await fixture(t);
  const first = writer(t, current, smaller);
  assert.equal(await first.first, "read");
  const second = writer(t, current, larger);
  const admission = await second.first;
  first.resume();
  assert.equal(await first.result, "success");
  await first.closed;
  // The old implementation reaches a second stale read. Let it finish to expose
  // the lost update; a serialized writer instead refuses before that callback.
  if (admission === "read") {
    second.resume();
  }
  const result = await second.result;
  await second.closed;
  assert.equal(result, "failure:FINDINGS_BASELINE_LOCK_UNAVAILABLE");
  assert.equal(await readFile(current.candidate, "utf8"), smaller);
  await assertReleased(current.root);
});

test("a stale preimage is refused and a later fresh write remains possible", async (t) => {
  const current = await fixture(t);
  await writeFile(current.candidate, larger);
  await assert.rejects(
    () => current.store.replace(current.root, current.path, smaller, original),
    (error) => hasCode(error, "FINDINGS_BASELINE_CHANGED"),
  );
  assert.equal(await readFile(current.candidate, "utf8"), larger);
  assert.deepEqual(await temporaries(current.candidate), []);
  await current.store.replace(current.root, current.path, smaller, larger);
  await assertReleased(current.root);
});

test("a change after preparation preserves the current baseline and cleans only its temporary", async (t) => {
  const current = await fixture(t);
  let reads = 0;
  const store = new FilesystemFindingsBaselineStore({
    ...observation,
    async read(input) {
      if (++reads === 2) {
        await writeFile(current.candidate, larger);
      }
      return readContainedRegularFile(input);
    },
  });
  await assert.rejects(
    () => store.replace(current.root, current.path, smaller, original),
    (error) => hasCode(error, "FINDINGS_BASELINE_CHANGED"),
  );
  assert.equal(await readFile(current.candidate, "utf8"), larger);
  assert.deepEqual(await temporaries(current.candidate), []);
  await assertReleased(current.root);
});

test("an active repository lease rejects a findings write without consuming it", async (t) => {
  const current = await fixture(t);
  const lease = await acquireMutationLease(current.root);
  try {
    await assert.rejects(
      () => current.store.replace(current.root, current.path, smaller, original),
      (error) => hasCode(error, "FINDINGS_BASELINE_LOCK_UNAVAILABLE"),
    );
    assert.equal(await readFile(current.candidate, "utf8"), original);
  } finally {
    await releaseMutationLease(lease);
  }
  await current.store.replace(current.root, current.path, smaller, original);
});

test("common mutation evidence is preserved with its recovery barrier", async (t) => {
  const current = await fixture(t);
  const directory = join(current.root, ".agent-teams-local");
  await mkdir(directory);
  const evidence = join(directory, "scaffolding-transaction.json");
  await writeFile(evidence, "interrupted mutation");
  await assert.rejects(
    () => current.store.replace(current.root, current.path, smaller, original),
    (error) => hasCode(error, "FINDINGS_BASELINE_CHANGED"),
  );
  assert.equal(await readFile(current.candidate, "utf8"), original);
  assert.equal(await readFile(evidence, "utf8"), "interrupted mutation");
  assert.equal(
    (
      JSON.parse(await readFile(join(directory, "foundation-operation.lock"), "utf8")) as {
        kind: string;
      }
    ).kind,
    "transaction-barrier",
  );
});

test("temporary substitution preserves foreign bytes and all cleanup and release failures", async (t) => {
  const current = await fixture(t);
  let reads = 0;
  let foreign = "";
  const lock = join(current.root, ".agent-teams-local/foundation-operation.lock");
  const store = new FilesystemFindingsBaselineStore({
    ...observation,
    async read(input) {
      const bytes = await readContainedRegularFile(input);
      if (++reads === 2) {
        const names = await temporaries(current.candidate);
        assert.equal(names.length, 1);
        foreign = join(dirname(current.candidate), names[0]!);
        await rename(foreign, `${foreign}.retained`);
        await writeFile(foreign, "foreign temporary", { flag: "wx" });
        await writeFile(lock, "foreign lock");
      }
      return bytes;
    },
  });
  await assert.rejects(
    () => store.replace(current.root, current.path, smaller, original),
    (error) => {
      const all = failures(error);
      assert.equal(
        all.filter(
          (entry) => entry instanceof Error && entry.name === "NodeAtomicFileReplacementError",
        ).length,
        2,
      );
      assert.ok(all.some((entry) => entry instanceof RepositoryMutationError));
      return true;
    },
  );
  assert.equal(await readFile(foreign, "utf8"), "foreign temporary");
  assert.equal(await readFile(lock, "utf8"), "foreign lock");
  assert.equal(await readFile(current.candidate, "utf8"), original);
});

test("physical-root observation failure retains the barrier and original failures", async (t) => {
  const current = await fixture(t);
  const originalRoot = `${current.root}-retained`;
  t.after(() => rm(originalRoot, { recursive: true, force: true }));
  let reads = 0;
  const store = new FilesystemFindingsBaselineStore({
    ...observation,
    async read(input) {
      const bytes = await readContainedRegularFile(input);
      if (++reads === 2) {
        await rename(current.root, originalRoot);
        await symlink(
          originalRoot,
          current.root,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return bytes;
    },
  });
  await assert.rejects(
    () => store.replace(current.root, current.path, smaller, original),
    (error) => {
      const all = failures(error);
      assert.ok(
        all.some(
          (entry) =>
            entry instanceof RepositoryMutationError && entry.code === "MUTATION_LEASE_INVALID",
        ),
      );
      assert.ok(
        all.some(
          (entry) => entry instanceof Error && entry.name === "NodeAtomicFileReplacementError",
        ),
      );
      return true;
    },
  );
  assert.equal(await readFile(join(originalRoot, current.path), "utf8"), original);
  assert.equal(
    (
      JSON.parse(
        await readFile(join(originalRoot, ".agent-teams-local/foundation-operation.lock"), "utf8"),
      ) as { kind: string }
    ).kind,
    "transaction-barrier",
  );
});

test("a post-replacement release failure reports uncertainty and preserves foreign evidence", async (t) => {
  const current = await fixture(t);
  const lock = join(current.root, ".agent-teams-local/foundation-operation.lock");
  let reads = 0;
  const store = new FilesystemFindingsBaselineStore({
    ...observation,
    async read(input) {
      const bytes = await readContainedRegularFile(input);
      if (++reads === 2) {
        await writeFile(lock, "foreign lock");
      }
      return bytes;
    },
  });
  await assert.rejects(
    () => store.replace(current.root, current.path, smaller, original),
    (error) => {
      assert.ok(error instanceof CapabilityInputError);
      assert.equal(error.problem.code, "FINDINGS_BASELINE_WRITE_UNCERTAIN");
      assert.ok(error.cause instanceof RepositoryMutationError);
      return true;
    },
  );
  assert.equal(await readFile(current.candidate, "utf8"), smaller);
  assert.equal(await readFile(lock, "utf8"), "foreign lock");
  assert.deepEqual(await temporaries(current.candidate), []);
});
