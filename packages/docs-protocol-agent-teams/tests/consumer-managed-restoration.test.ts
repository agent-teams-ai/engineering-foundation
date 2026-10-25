import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { applyKnownFileTransaction, sha256Bytes } from "@agent-teams/repository-mutation";
import {
  finalizeManagedConsumerRestoration,
  restoreManagedConsumerIntegration,
} from "../dist/consumer-integration/adapters/node-managed-restoration.js";
import { parseManagedPreparation } from "../dist/consumer-integration/adapters/node-managed-restoration-preparation.js";
import { fixtureGit as git, retainedFixture, revision } from "./managed-restoration-fixture.ts";

type Fixture = Awaited<ReturnType<typeof retainedFixture>>;
async function admittedController(f: Fixture): Promise<boolean> {
  if (process.versions.node === "24.21.0") {
    return true;
  }
  await assert.rejects(f.prepare(), /actual Node24\.21\.0/u);
  return false;
}
async function assertImages(f: Fixture, target: boolean) {
  for (const [path, bytes] of target ? f.postimages : f.originals) {
    assert.deepEqual(await readFile(join(f.root, path)), bytes, path);
  }
}
async function coldFinalize(f: Fixture, expect: string, crash = false) {
  const module = new URL(
    "../dist/consumer-integration/adapters/node-managed-restoration.js",
    import.meta.url,
  ).href;
  const script = `import {finalizeManagedConsumerRestoration} from ${JSON.stringify(module)};
const projection=cohort=>({repository:'agent-teams-ai/.github',path:'governance/docs-qualified-cohorts.json',revision:${JSON.stringify(revision)},cohort});
const result=await finalizeManagedConsumerRestoration(${JSON.stringify({ ...f.options, expect })},{
 authority:{read:async()=>projection(${JSON.stringify(f.target.cohort)}),readManagedRestoration:async()=>({revision:${JSON.stringify(revision)},target:projection(${JSON.stringify(f.current.cohort)})})},
 sandbox:{verifyManagedRuntime:async()=>{},activateAndVerifyManaged:async()=>{${crash ? "process.exit(73);" : ""}}}
});process.stdout.write(JSON.stringify(result));`;
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

void test("retained2-to3 intent rejects digest substitution and an unknown evidence family", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  await assertImages(f, false);
  const bytes = await readFile(prepared.path);
  assert.throws(
    () => parseManagedPreparation(bytes, `sha256:${"0".repeat(64)}`),
    /selected digest/u,
  );
  const changed = Buffer.from(
    bytes
      .toString()
      .replace("managed-generation3-preparation/v1", "managed-v1-restoration-preparation/v1"),
  );
  assert.throws(() => parseManagedPreparation(changed, sha256Bytes(changed)), /family/u);
  assert.deepEqual(f.activation, []);
});

void test("crash after publication before activation resumes in a fresh controller and deliberately restores3-to2", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  const first = await coldFinalize(f, prepared.digest, true);
  if (process.platform === "win32") {
    assert.notEqual(first.code, 0);
    assert.match(first.stderr, /KNOWN_FILE_APPLY_UNSUPPORTED|not supported/u);
    await assertImages(f, false);
    return;
  }
  assert.equal(first.code, 73, first.stderr);
  await assertImages(f, true);
  await assert.rejects(readFile(f.options.proofPath), { code: "ENOENT" });
  assert.ok((await readFile(`${f.options.proofPath}.receipt`)).byteLength > 0);
  const resumed = await coldFinalize(f, prepared.digest);
  assert.equal(resumed.code, 0, JSON.stringify({ signal: resumed.signal, stderr: resumed.stderr }));
  const result: unknown = JSON.parse(resumed.stdout);
  assert.ok(typeof result === "object" && result !== null && "receipt" in result);
  assert.deepEqual(f.activation, []); // The second process owns its activation port.
  const restored = await restoreManagedConsumerIntegration(
    {
      consumerRoot: f.root,
      sourceGeneration: 3,
      targetGeneration: 2,
      from: f.target.cohort.cohortId,
      to: f.current.cohort.cohortId,
      preparationPath: prepared.path,
      expect: prepared.digest,
    },
    f,
  );
  assert.equal(restored.outcome, "restored");
  assert.equal(restored.receipt?.outcome, "applied");
  await assertImages(f, false);
  assert.deepEqual(f.activation, ["origin"]);
  // A completed selection cannot be used to republish after its deliberate rollback.
  await assert.rejects(
    finalizeManagedConsumerRestoration({ ...f.options, expect: prepared.digest }, f),
    /cannot silently publish again/u,
  );
});

void test("lost receipt companion after exact publication uses honest already-satisfied cold observation", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  const operation = finalizeManagedConsumerRestoration(
    { ...f.options, expect: prepared.digest },
    {
      ...f,
      apply: async (options) => {
        await applyKnownFileTransaction(options);
        throw new Error("TEST_LOST_AFTER_PUBLICATION");
      },
    },
  );
  if (process.platform === "win32") {
    await assert.rejects(operation, { code: "KNOWN_FILE_APPLY_UNSUPPORTED" });
    await assertImages(f, false);
    return;
  }
  await assert.rejects(operation, /TEST_LOST_AFTER_PUBLICATION/u);
  await assertImages(f, true);
  await assert.rejects(readFile(`${f.options.proofPath}.receipt`), { code: "ENOENT" });
  const resumed = await coldFinalize(f, prepared.digest);
  assert.equal(resumed.code, 0, JSON.stringify({ signal: resumed.signal, stderr: resumed.stderr }));
  const companion: unknown = JSON.parse(await readFile(`${f.options.proofPath}.receipt`, "utf8"));
  assert.ok(typeof companion === "object" && companion !== null && "receipt" in companion);
  assert.ok(
    typeof companion.receipt === "object" &&
      companion.receipt !== null &&
      "outcome" in companion.receipt,
  );
  assert.equal(companion.receipt.outcome, "already-satisfied");
});

void test("foreign postimage and unavailable recorded controller build refuse cold finalization without replacing data", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  await writeFile(join(f.root, ".node-version"), "foreign\n");
  await assert.rejects(
    finalizeManagedConsumerRestoration({ ...f.options, expect: prepared.digest }, f),
    /current bytes or mode differ/u,
  );
  assert.equal(await readFile(join(f.root, ".node-version"), "utf8"), "foreign\n");
  await writeFile(join(f.root, ".node-version"), f.originals.get(".node-version")!);
  const value: unknown = JSON.parse(await readFile(prepared.path, "utf8"));
  assert.ok(typeof value === "object" && value !== null && "controller" in value);
  const altered = {
    ...value,
    controller: {
      name: "@agent-teams/docs-protocol-agent-teams",
      version: "0.0.0",
      buildIdentity: `sha256:${"7".repeat(64)}`,
    },
  };
  // Use the production canonical serializer, including nested controller keys.
  const { restorationJson } =
    await import("../dist/consumer-integration/application/policies/consumer-restoration-proof.js");
  const selected = Buffer.from(`${restorationJson(altered)}\n`);
  await writeFile(prepared.path, selected);
  await assert.rejects(
    finalizeManagedConsumerRestoration({ ...f.options, expect: sha256Bytes(selected) }, f),
    /exact external controller and kernel/u,
  );
  await assertImages(f, false);
});

void test("stale authority and changed source rollback binding fail before any publication", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  await assert.rejects(
    finalizeManagedConsumerRestoration(
      { ...f.options, expect: prepared.digest },
      {
        ...f,
        authority: {
          ...f.authority,
          read: async () => ({ ...(await f.authority.read()), revision: "b".repeat(40) }),
        },
      },
    ),
    /fresh protected selection/u,
  );
  await assertImages(f, false);
  await assert.rejects(
    finalizeManagedConsumerRestoration(
      { ...f.options, expect: prepared.digest },
      {
        ...f,
        authority: {
          ...f.authority,
          readManagedRestoration: async () => ({
            revision,
            target: {
              ...(
                await f.authority.readManagedRestoration({
                  source: f.target.cohort,
                  origin: f.current.cohort,
                  repository: f.current.repository,
                })
              ).target,
              cohort: { ...f.current.cohort, recordDigest: `sha256:${"7".repeat(64)}` },
            },
          }),
        },
      },
    ),
    /fresh authority/u,
  );
  await assertImages(f, false);
  assert.deepEqual(f.activation, []);
});

void test("failed live activation compensates only receipt-owned bytes and refuses foreign postimages", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  const operation = finalizeManagedConsumerRestoration(
    { ...f.options, expect: prepared.digest },
    {
      ...f,
      sandbox: {
        ...f.sandbox,
        activateAndVerifyManaged: async () => {
          throw new Error("TEST_ACTIVATION_FAILED");
        },
      },
    },
  );
  if (process.platform === "win32") {
    await assert.rejects(operation, { code: "KNOWN_FILE_APPLY_UNSUPPORTED" });
    await assertImages(f, false);
    return;
  }
  await assert.rejects(operation, /TEST_ACTIVATION_FAILED/u);
  await assertImages(f, false);
  assert.deepEqual(f.activation, ["origin"]);
  const foreign = await retainedFixture(t);
  const selected = await foreign.prepare();
  await assert.rejects(
    finalizeManagedConsumerRestoration(
      { ...foreign.options, expect: selected.digest },
      {
        ...foreign,
        sandbox: {
          ...foreign.sandbox,
          activateAndVerifyManaged: async () => {
            await writeFile(join(foreign.root, ".node-version"), "foreign\n");
            throw new Error("TEST_ACTIVATION_FAILED");
          },
        },
      },
    ),
    /current bytes or mode differ/u,
  );
  assert.equal(await readFile(join(foreign.root, ".node-version"), "utf8"), "foreign\n");
  assert.deepEqual(foreign.activation, []);
});

void test("cold finalization refuses a missing or wrong selected runtime before CAS publication", async (t) => {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  await assert.rejects(
    finalizeManagedConsumerRestoration(
      { ...f.options, expect: prepared.digest },
      {
        ...f,
        sandbox: {
          ...f.sandbox,
          verifyManagedRuntime: async (selected) => {
            assert.equal(selected.cohort.schemaVersion, 3);
            assert.equal(selected.packageManager, "pnpm@11.20.0");
            throw new Error("TEST_WRONG_TARGET_RUNTIME");
          },
        },
      },
    ),
    /TEST_WRONG_TARGET_RUNTIME/u,
  );
  await assertImages(f, false);
  assert.deepEqual(f.activation, []);
  await assert.rejects(readFile(`${f.options.proofPath}.receipt`), { code: "ENOENT" });
});

async function assertPreflightHeadRefusal(t: TestContext, reverse: boolean) {
  const f = await retainedFixture(t);
  if (!(await admittedController(f))) {
    return;
  }
  const prepared = await f.prepare();
  if (reverse) {
    const forward = finalizeManagedConsumerRestoration(
      { ...f.options, expect: prepared.digest },
      f,
    );
    if (process.platform === "win32") {
      await assert.rejects(forward, { code: "KNOWN_FILE_APPLY_UNSUPPORTED" });
      return;
    }
    await forward;
    f.activation.length = 0;
  }
  const tree = git(f.root, "rev-parse", "HEAD^{tree}");
  let applyCalls = 0;
  let preflightObserved = false;
  const ports = {
    ...f,
    sandbox: {
      ...f.sandbox,
      verifyManagedRuntime: async () => {
        git(f.root, "commit", "--allow-empty", "-qm", "test: move HEAD during runtime preflight");
        assert.equal(git(f.root, "rev-parse", "HEAD^{tree}"), tree);
        preflightObserved = true;
      },
    },
    apply: async (): Promise<never> => {
      applyCalls += 1;
      throw new Error("TEST_UNEXPECTED_APPLY_AFTER_HEAD_CHANGE");
    },
  };
  const operation = reverse
    ? restoreManagedConsumerIntegration(
        {
          consumerRoot: f.root,
          sourceGeneration: 3,
          targetGeneration: 2,
          from: f.target.cohort.cohortId,
          to: f.current.cohort.cohortId,
          preparationPath: prepared.path,
          expect: prepared.digest,
        },
        ports,
      )
    : finalizeManagedConsumerRestoration({ ...f.options, expect: prepared.digest }, ports);
  await assert.rejects(operation, /source Git revision\/tree changed/u);
  assert.equal(preflightObserved, true);
  assert.equal(applyCalls, 0);
  assert.deepEqual(f.activation, []);
  await assertImages(f, reverse);
}

void test("finalization refuses an identical-tree preflight HEAD change before CAS or activation", async (t) => {
  await assertPreflightHeadRefusal(t, false);
});

void test("original restoration refuses an identical-tree preflight HEAD change before CAS or activation", async (t) => {
  await assertPreflightHeadRefusal(t, true);
});
