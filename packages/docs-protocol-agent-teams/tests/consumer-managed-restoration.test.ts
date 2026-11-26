import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  applyKnownFileTransaction,
  compileKnownFileTransactionPlan,
  sha256Bytes,
} from "@agent-teams/repository-mutation";
import {
  finalizeManagedConsumerRestoration,
  restoreManagedConsumerIntegration,
} from "../dist/consumer-integration/adapters/node-managed-restoration.js";
import {
  managedRestorationRecorder,
  parseManagedPreparation,
} from "../dist/consumer-integration/adapters/node-managed-restoration-preparation.js";
import { nodeManagedGeneration2SourceInputReader } from "../dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import { packageConsumerAssetCatalogReader } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import { createConsumerUpgradeUseCase } from "../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import { foundationKnownFileTransaction } from "../dist/consumer-integration/composition/known-file-transaction.js";
import { fixtureGit as git, retainedFixture, revision } from "./managed-restoration-fixture.ts";

type Fixture = Awaited<ReturnType<typeof retainedFixture>>;
function scenario(
  name: string,
  run: (context: TestContext, fixture: Fixture) => Promise<void>,
): void {
  for (const sourceNodePin of ["24.21.0\n", "26.11.1\n"] as const) {
    const identity = sourceNodePin === "24.21.0\n" ? name : `${name} [preserved host Node26]`;
    void test(
      process.platform === "win32" ? `${identity} [Windows runtime refusal]` : identity,
      async (context) => {
        const fixture = await retainedFixture(context, sourceNodePin);
        if (process.platform === "win32") {
          assert.equal(process.versions.node.split(".")[0], "26");
          await assert.rejects(fixture.prepare(), /actual Node24\.21\.0/u);
          await assertImages(fixture, false);
          assert.deepEqual(fixture.activation, []);
          context.diagnostic(
            "Windows default Node26 refusal only; no positive mutation or recovery claim.",
          );
          return;
        }
        assert.equal(
          process.versions.node,
          "24.21.0",
          "Positive retained-controller cases require the selected physical Node24.21.0 test route.",
        );
        context.diagnostic(
          `controller=${process.versions.node}; source-pin=${sourceNodePin.trim()}; TEST activation ports`,
        );
        await run(context, fixture);
      },
    );
  }
}
async function assertImages(f: Fixture, target: boolean) {
  for (const [path, bytes] of target ? f.postimages : f.originals) {
    assert.deepEqual(await readFile(join(f.root, path)), bytes, path);
  }
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(f.root, ".node-version"))).mode & 0o777, 0o644);
  }
}
function inputOperations(f: Fixture) {
  return f.plan.operations.map((operation) => {
    assert.ok(operation.precondition.state === "known-file");
    return {
      path: operation.path,
      precondition: {
        state: "known-file" as const,
        acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
          bytes: Buffer.from(image.contentBase64, "base64"),
          mode: image.mode,
        })),
      },
      postimage: {
        bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
        mode: operation.postimage.mode,
      },
    };
  });
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

scenario(
  "retained2-to3 intent rejects digest substitution and an unknown evidence family",
  async (_t, f) => {
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
  },
);

scenario(
  "retained preparation keeps exact pin ownership and rejects a forged no-op pin write",
  async (_t, f) => {
    const writesPin = f.plan.operations.some(({ path }) => path === ".node-version");
    assert.equal(writesPin, f.sourceNodePin === "24.21.0\n");
    if (!writesPin) {
      const noop = compileKnownFileTransactionPlan({
        operations: [
          ...inputOperations(f),
          {
            path: ".node-version",
            precondition: {
              state: "known-file",
              acceptedPreimages: [{ bytes: Buffer.from(f.sourceNodePin), mode: 0o644 }],
            },
            postimage: { bytes: Buffer.from(f.sourceNodePin), mode: 0o644 },
          },
        ],
      });
      await assert.rejects(
        f.prepare(noop),
        /plan differs from deterministic managed write inventory/u,
      );
      await assert.rejects(readFile(f.options.preparationPath), { code: "ENOENT" });
    }
    const prepared = await f.prepare();
    const retained = parseManagedPreparation(await readFile(prepared.path), prepared.digest);
    assert.equal(
      retained.plan.operations.some(({ path }) => path === ".node-version"),
      writesPin,
    );
    await assertImages(f, false);
    assert.deepEqual(f.activation, []);
  },
);

scenario(
  "staging-time non-Git pin mode drift refuses before retained preparation or consumer publication",
  async (_t, f) => {
    const pin = join(f.root, ".node-version");
    let staging = 0;
    let publications = 0;
    const upgrade = createConsumerUpgradeUseCase({
      input: nodeManagedGeneration2SourceInputReader,
      assets: packageConsumerAssetCatalogReader,
      planning: f.planning,
      authority: f.authority,
      transaction: {
        ...foundationKnownFileTransaction,
        apply: async (): Promise<never> => {
          publications += 1;
          throw new Error("TEST_UNEXPECTED_CAS_AFTER_STAGING_DRIFT");
        },
      },
      sandbox: {
        ...f.sandbox,
        prepareManaged: async () => {
          staging += 1;
          await chmod(pin, 0o600);
          assert.equal(git(f.root, "diff", "--name-only"), "");
          return { operations: inputOperations(f) };
        },
      },
      restoration: {
        prepare: async (): Promise<never> => {
          throw new Error("TEST_UNSELECTED_LEGACY_PREPARATION");
        },
        prepareManaged: managedRestorationRecorder(f.authority),
      },
    });
    try {
      await assert.rejects(
        upgrade({
          consumerRoot: f.root,
          to: f.target.cohort.cohortId,
          sourceGeneration: 2,
          targetGeneration: 3,
          prepare: true,
          restorationProofPath: f.options.proofPath,
        }),
        f.sourceNodePin === "26.11.1\n"
          ? { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" }
          : /current bytes or mode differ/u,
      );
      assert.equal(staging, 1);
      assert.equal(publications, 0);
      assert.equal((await lstat(pin)).mode & 0o777, 0o600);
      assert.deepEqual(f.activation, []);
      await assert.rejects(readFile(f.options.preparationPath), { code: "ENOENT" });
      await assert.rejects(readFile(`${f.options.proofPath}.receipt`), { code: "ENOENT" });
    } finally {
      await chmod(pin, 0o644);
    }
    await assertImages(f, false);
  },
);

scenario(
  "crash after publication before activation resumes in a fresh controller and deliberately restores3-to2",
  async (_t, f) => {
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
    assert.equal(
      resumed.code,
      0,
      JSON.stringify({ signal: resumed.signal, stderr: resumed.stderr }),
    );
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
    assert.equal(
      restored.receipt?.operations.some(({ path }) => path === ".node-version"),
      f.sourceNodePin === "24.21.0\n",
    );
    await assertImages(f, false);
    assert.deepEqual(f.activation, ["origin"]);
    // A completed selection cannot be used to republish after its deliberate rollback.
    await assert.rejects(
      finalizeManagedConsumerRestoration({ ...f.options, expect: prepared.digest }, f),
      /cannot silently publish again/u,
    );
  },
);

scenario(
  "lost receipt companion after exact publication uses honest already-satisfied cold observation",
  async (_t, f) => {
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
    assert.equal(
      resumed.code,
      0,
      JSON.stringify({ signal: resumed.signal, stderr: resumed.stderr }),
    );
    const companion: unknown = JSON.parse(await readFile(`${f.options.proofPath}.receipt`, "utf8"));
    assert.ok(typeof companion === "object" && companion !== null && "receipt" in companion);
    assert.ok(
      typeof companion.receipt === "object" &&
        companion.receipt !== null &&
        "outcome" in companion.receipt,
    );
    assert.equal(companion.receipt.outcome, "already-satisfied");
  },
);

scenario(
  "foreign postimage and unavailable recorded controller build refuse cold finalization without replacing data",
  async (_t, f) => {
    const prepared = await f.prepare();
    await writeFile(join(f.root, ".node-version"), "foreign\n");
    await assert.rejects(
      finalizeManagedConsumerRestoration({ ...f.options, expect: prepared.digest }, f),
      f.sourceNodePin === "26.11.1\n"
        ? { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" }
        : /current bytes or mode differ|repository contains unrelated edits/u,
    );
    assert.deepEqual(f.activation, []);
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
  },
);

scenario(
  "stale authority and changed source rollback binding fail before any publication",
  async (_t, f) => {
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
  },
);

scenario(
  "failed live activation compensates only receipt-owned bytes and refuses foreign postimages",
  async (_t, f) => {
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
    await _t.test(
      "foreign postimage remains untouched after activation failure",
      async (context) => {
        const foreign = await retainedFixture(context, f.sourceNodePin);
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
          f.sourceNodePin === "26.11.1\n"
            ? { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" }
            : /current bytes or mode differ|repository contains unrelated edits/u,
        );
        assert.equal(await readFile(join(foreign.root, ".node-version"), "utf8"), "foreign\n");
        assert.deepEqual(foreign.activation, []);
      },
    );
  },
);

scenario(
  "cold finalization refuses a missing or wrong selected runtime before CAS publication",
  async (_t, f) => {
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
  },
);

scenario(
  "runtime preflight pin-byte and non-Git mode drift refuse before CAS publication",
  async (_t, f) => {
    const prepared = await f.prepare();
    const pin = join(f.root, ".node-version");
    for (const drift of ["bytes", "mode"] as const) {
      let publications = 0;
      let observations = 0;
      try {
        await assert.rejects(
          finalizeManagedConsumerRestoration(
            { ...f.options, expect: prepared.digest },
            {
              ...f,
              sandbox: {
                ...f.sandbox,
                verifyManagedRuntime: async () => {
                  observations += 1;
                  if (drift === "bytes") {
                    await writeFile(pin, "26.11.2\n");
                  } else {
                    await chmod(pin, 0o600);
                    assert.equal(git(f.root, "diff", "--name-only"), "");
                  }
                },
              },
              apply: async (): Promise<never> => {
                publications += 1;
                throw new Error("TEST_UNEXPECTED_CAS_AFTER_PIN_DRIFT");
              },
            },
          ),
          /current bytes or mode differ|repository contains unrelated edits/u,
        );
        assert.equal(observations, 1);
        assert.equal(publications, 0);
        assert.deepEqual(f.activation, []);
        await assert.rejects(readFile(`${f.options.proofPath}.receipt`), { code: "ENOENT" });
      } finally {
        await writeFile(pin, f.sourceNodePin);
        await chmod(pin, 0o644);
      }
      await assertImages(f, false);
    }
  },
);

async function assertPreflightHeadRefusal(f: Fixture, reverse: boolean) {
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

scenario(
  "finalization refuses an identical-tree preflight HEAD change before CAS or activation",
  async (_t, f) => {
    await assertPreflightHeadRefusal(f, false);
  },
);

scenario(
  "original restoration refuses an identical-tree preflight HEAD change before CAS or activation",
  async (_t, f) => {
    await assertPreflightHeadRefusal(f, true);
  },
);
