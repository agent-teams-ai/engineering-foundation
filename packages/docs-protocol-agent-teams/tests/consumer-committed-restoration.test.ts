import { acquireMutationLease, releaseMutationLease } from "@agent-teams/repository-mutation/node";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { sha256Bytes } from "@agent-teams/repository-mutation";
import {
  finalizeManagedConsumerRestoration,
  restoreManagedConsumerIntegration,
} from "../dist/consumer-integration/adapters/node-managed-restoration.js";
import { restoreCommittedManagedConsumer } from "../dist/consumer-integration/adapters/node-managed-committed-restoration.js";
import { fixtureGit as git, retainedFixture, revision } from "./managed-restoration-fixture.ts";

async function published(t: TestContext) {
  const f = await retainedFixture(t);
  if (process.versions.node !== "24.21.0") {
    await assert.rejects(f.prepare(), /actual Node24\.21\.0/u);
    return;
  }
  const prepared = await f.prepare();
  const forward = finalizeManagedConsumerRestoration({ ...f.options, expect: prepared.digest }, f);
  if (process.platform === "win32") {
    await assert.rejects(forward, { code: "KNOWN_FILE_APPLY_UNSUPPORTED" });
    return;
  }
  assert.equal((await forward).outcome, "upgraded");
  return { ...f, prepared };
}
type Fixture = NonNullable<Awaited<ReturnType<typeof published>>>;
function options(f: Fixture, root = f.root, label = "current-selection") {
  return {
    consumerRoot: root,
    sourceGeneration: 3 as const,
    targetGeneration: 2 as const,
    from: f.target.cohort.cohortId,
    to: f.current.cohort.cohortId,
    preparationPath: f.prepared.path,
    expect: f.prepared.digest,
    currentRevision: git(root, "rev-parse", "HEAD"),
    currentTree: git(root, "rev-parse", "HEAD^{tree}"),
    selectionPath: join(f.disposable, `${label}.json`),
  };
}
function commit(root: string, message: string) {
  git(root, "add", "--all");
  git(root, "commit", "-qm", message);
}
function committedTarget(f: Fixture) {
  const sourceBranch = git(f.root, "symbolic-ref", "--short", "HEAD");
  git(f.root, "checkout", "-qb", "TEST-adoption");
  commit(f.root, "test: adopt actual managed target images");
  git(f.root, "checkout", "-q", sourceBranch);
  git(f.root, "merge", "--no-ff", "-qm", "test: merge target adoption", "TEST-adoption");
}
async function assertBytes(root: string, images: ReadonlyMap<string, Buffer>) {
  for (const [path, bytes] of images) {
    assert.deepEqual(await readFile(join(root, path)), bytes, path);
  }
}
function child(script: string) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    killed: boolean;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 240_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({
          code,
          signal: error?.signal ?? null,
          killed: error?.killed ?? false,
          stdout,
          stderr,
        });
      },
    ).once("error", reject);
  });
}
const freshSourceScript = (root: string) => `
const assert=(await import('node:assert/strict')).default;
const {checkConsumerIntegration}=await import(${JSON.stringify(new URL("../dist/consumer-integration/composition/node-consumer-integration.js", import.meta.url).href)});
assert.equal(process.versions.node,'24.21.0');
const observed=await checkConsumerIntegration({consumerRoot:${JSON.stringify(root)}});
assert.equal(observed.outcome,'current',JSON.stringify(observed));
`;

void test("merged target admits a fresh root, refuses overlapping Host changes, and restores only managed files", async (t) => {
  const f = await published(t);
  if (f === undefined) {
    return;
  }
  committedTarget(f);
  await assert.rejects(
    restoreManagedConsumerIntegration(
      {
        consumerRoot: f.root,
        sourceGeneration: 3,
        targetGeneration: 2,
        from: f.target.cohort.cohortId,
        to: f.current.cohort.cohortId,
        preparationPath: f.prepared.path,
        expect: f.prepared.digest,
      },
      f,
    ),
    /source Git revision\/tree changed/u,
  );
  await writeFile(join(f.root, "host-business.txt"), "preserve later product work\n");
  const raw: unknown = JSON.parse(await readFile(join(f.root, "package.json"), "utf8"));
  assert.ok(
    typeof raw === "object" &&
      raw !== null &&
      "scripts" in raw &&
      typeof raw.scripts === "object" &&
      raw.scripts !== null,
  );
  const manifest = { ...raw, scripts: { ...raw.scripts, "check:host-f3": "stack-toolchain lint" } };
  await writeFile(join(f.root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(f.root, "toolchain.config.json"), '{"profile":"TEST-Host-F3"}\n');
  commit(f.root, "test: add Host changes and unrelated product work");
  const untouched = new Map(
    await Promise.all(
      [...f.postimages.keys()].map(
        async (path) => [path, await readFile(join(f.root, path))] as const,
      ),
    ),
  );
  const current = join(f.disposable, "fresh-current-root");
  git(f.disposable, "clone", "--no-hardlinks", "-q", f.root, current);
  git(current, "config", "user.name", "Managed restoration TEST fixture");
  git(current, "config", "user.email", "test@example.invalid");
  const foreign = options(f, current);
  await assert.rejects(
    restoreCommittedManagedConsumer(foreign, f),
    /committed managed postimage changed/u,
  );
  assert.equal(
    await readFile(join(current, "host-business.txt"), "utf8"),
    "preserve later product work\n",
  );
  await assert.rejects(readFile(foreign.selectionPath), { code: "ENOENT" });
  // TEST Host reversal removes only its own addition, retaining the Cohort3 managed values.
  await writeFile(join(current, "package.json"), `${JSON.stringify(raw, null, 2)}\n`);
  await rm(join(current, "toolchain.config.json"));
  commit(current, "test: reverse owned Host configuration before managed rollback");
  const selected = options(f, current);
  const result = await restoreCommittedManagedConsumer(selected, {
    ...f,
    sandbox: {
      ...f.sandbox,
      restoreCommittedAndVerifyManaged: async (input) => {
        const checked = await child(freshSourceScript(input.consumerRoot));
        assert.equal(checked.code, 0, checked.stderr || checked.stdout);
      },
    },
  });
  assert.equal(result.outcome, "restored");
  assert.equal(result.receipt?.outcome, "applied");
  await assertBytes(current, f.originals);
  await assertBytes(f.root, untouched);
  assert.equal(
    await readFile(join(current, "host-business.txt"), "utf8"),
    "preserve later product work\n",
  );
  const repeated = await restoreCommittedManagedConsumer(
    { ...selected, selectionExpect: result.proofDigest! },
    f,
  );
  assert.equal(repeated.receipt?.outcome, "already-satisfied");
});

void test("dirty targets, unknown lineage, stale HEAD and foreign committed managed bytes refuse without CAS", async (t) => {
  const f = await published(t);
  if (f === undefined) {
    return;
  }
  committedTarget(f);
  const selected = options(f);
  let writes = 0;
  const ports = {
    ...f,
    apply: async (): Promise<never> => {
      writes += 1;
      throw new Error("CAS must not run");
    },
  };
  await assert.rejects(
    restoreCommittedManagedConsumer({ ...selected, currentRevision: "b".repeat(40) }, ports),
    /HEAD\/tree is stale|must be clean/u,
  );
  const foreignLease = await acquireMutationLease(f.root);
  try {
    await assert.rejects(restoreCommittedManagedConsumer(selected, ports), {
      code: "KNOWN_FILE_OPERATION_ACTIVE",
    });
  } finally {
    await releaseMutationLease(foreignLease);
  }
  await writeFile(join(f.root, "unowned-dirty.txt"), "dirty\n");
  await assert.rejects(restoreCommittedManagedConsumer(selected, ports), /clean|dirty|untracked/u);
  await rm(join(f.root, "unowned-dirty.txt"));
  const manifest = await readFile(join(f.root, ".node-version"));
  await writeFile(join(f.root, ".node-version"), "foreign\n");
  commit(f.root, "test: foreign managed postimage");
  await assert.rejects(
    restoreCommittedManagedConsumer(options(f), ports),
    /committed managed postimage changed/u,
  );
  assert.equal(await readFile(join(f.root, ".node-version"), "utf8"), "foreign\n");
  await writeFile(join(f.root, ".node-version"), manifest);
  commit(f.root, "test: restore owned target fixture image");
  git(f.root, "checkout", "--orphan", "TEST-unknown-lineage");
  commit(f.root, "test: copied target without original source ancestry");
  await assert.rejects(
    restoreCommittedManagedConsumer(options(f), ports),
    /unknown original-source lineage/u,
  );
  assert.equal(writes, 0);
  await assert.rejects(readFile(selected.selectionPath), { code: "ENOENT" });
});

void test("committed rollback cold-resumes its separately selected current intent before fresh Node24 check", async (t) => {
  const f = await published(t);
  if (f === undefined) {
    return;
  }
  committedTarget(f);
  const selected = options(f);
  const module = new URL(
    "../dist/consumer-integration/adapters/node-managed-committed-restoration.js",
    import.meta.url,
  ).href;
  const planner = new URL(
    "../dist/consumer-integration/composition/consumer-integration-planner.js",
    import.meta.url,
  ).href;
  const script = (selectionExpect?: string) => `
import {restoreCommittedManagedConsumer} from ${JSON.stringify(module)};
import {consumerIntegrationPlanningPorts} from ${JSON.stringify(planner)};
const origin=${JSON.stringify(f.current.cohort)};
console.error('TEST_CURRENT_RESTORE_STARTED');
const result=await restoreCommittedManagedConsumer(${JSON.stringify({ ...selected, ...(selectionExpect === undefined ? {} : { selectionExpect }) })},{
 authority:{readManagedRestoration:async()=>({revision:${JSON.stringify(revision)},target:{repository:'agent-teams-ai/.github',path:'governance/docs-qualified-cohorts.json',revision:${JSON.stringify(revision)},cohort:origin}})},
 planning:consumerIntegrationPlanningPorts,
 sandbox:{verifyManagedRuntime:async()=>{console.error('TEST_CURRENT_RUNTIME_PREFLIGHT');},restoreCommittedAndVerifyManaged:async()=>{console.error('TEST_CURRENT_INVERSE_PUBLISHED');${selectionExpect === undefined ? "process.exit(73);" : freshSourceScript(f.root)}}}
});console.log(JSON.stringify(result));`;
  const first = await child(script());
  assert.equal(first.code, 73, JSON.stringify(first));
  await assertBytes(f.root, f.originals);
  const digest = sha256Bytes(await readFile(selected.selectionPath));
  await assert.rejects(restoreCommittedManagedConsumer(selected, f), /separately selected digest/u);
  await assert.rejects(
    restoreCommittedManagedConsumer(
      { ...selected, selectionExpect: `sha256:${"0".repeat(64)}` },
      f,
    ),
    /differs from separately retained digest/u,
  );
  const resumed = await child(script(digest));
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  const result: unknown = JSON.parse(resumed.stdout);
  assert.ok(
    typeof result === "object" && result !== null && "outcome" in result && "receipt" in result,
  );
  assert.equal(result.outcome, "restored");
  assert.ok(
    typeof result.receipt === "object" && result.receipt !== null && "outcome" in result.receipt,
  );
  assert.equal(result.receipt.outcome, "already-satisfied");
  commit(f.root, "test: commit completed rollback");
  await assert.rejects(
    restoreCommittedManagedConsumer({ ...selected, selectionExpect: digest }, f),
    /HEAD\/tree is stale/u,
  );
});
