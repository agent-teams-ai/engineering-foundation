import assert from "node:assert/strict";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { compileKnownFileTransactionPlan } from "@agent-teams/repository-mutation";
import { nodeManagedGeneration2SourceInputReader } from "../dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import { NodeConsumerUpgradeSandbox } from "../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";
import { INTEGRATION_PROFILE_PATH } from "../dist/consumer-integration/adapters/node-consumer-repository-files.js";
import { packageConsumerAssetCatalogReader } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import { createRetainedGeneration2SourceVerifier } from "../dist/consumer-integration/adapters/node-retained-source-verifier.js";
import {
  managedRestorationRecorder,
  parseManagedPreparation,
} from "../dist/consumer-integration/adapters/node-managed-restoration-preparation.js";
import { createConsumerUpgradeUseCase } from "../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import { foundationKnownFileTransaction } from "../dist/consumer-integration/composition/known-file-transaction.js";
import {
  assertRetainedImages as assertImages,
  fixtureGit as git,
  retainedFixture,
  retainedScenario as scenario,
} from "./managed-restoration-fixture.ts";

type Fixture = Awaited<ReturnType<typeof retainedFixture>>;

function sourceScenario(name: string, run: (fixture: Fixture) => Promise<void>): void {
  for (const sourceNodePin of ["26.11.1\n", "26.12.1\n"] as const) {
    const identity = `${name} [preserved host Node${sourceNodePin.trim()}]`;
    void test(
      process.platform === "win32" ? `${identity} [Windows runtime refusal]` : identity,
      async (context) => {
        const fixture = await retainedFixture(context, sourceNodePin);
        if (process.platform === "win32") {
          assert.equal(process.versions.node.split(".")[0], "26");
          await assert.rejects(
            nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
            { code: "DOCS_CONSUMER_UNSUPPORTED_NODE" },
          );
          await assertUnchanged(fixture);
          context.diagnostic(
            "Windows default Node26 refusal only; no positive source observation claim.",
          );
          return;
        }
        assert.equal(
          process.versions.node,
          "24.22.3",
          "Select the physical retained-controller test runtime.",
        );
        await run(fixture);
      },
    );
  }
}

async function assertUnchanged(fixture: Fixture): Promise<void> {
  for (const [path, bytes] of fixture.originals) {
    assert.deepEqual(await readFile(join(fixture.root, path)), bytes, path);
  }
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(fixture.root, ".node-version"))).mode & 0o777, 0o644);
  }
  assert.deepEqual(fixture.activation, []);
  await assert.rejects(readFile(fixture.options.proofPath), { code: "ENOENT" });
}

function verifier(fixture: Fixture) {
  return createRetainedGeneration2SourceVerifier({
    input: nodeManagedGeneration2SourceInputReader,
    assets: packageConsumerAssetCatalogReader,
    planning: fixture.planning,
  });
}

sourceScenario(
  "retained verifier compares the complete original profile before consulting assets",
  async (fixture) => {
    let assetReads = 0;
    const observe = createRetainedGeneration2SourceVerifier({
      input: nodeManagedGeneration2SourceInputReader,
      assets: {
        read: async () => {
          assetReads += 1;
          return packageConsumerAssetCatalogReader.read();
        },
      },
      planning: fixture.planning,
    });
    const otherProfile = {
      ...fixture.current,
      profilePath: "architecture/foundation/other-docs.yaml",
    };
    assert.deepEqual(otherProfile.cohort, fixture.current.cohort);
    await assert.rejects(observe({ consumerRoot: fixture.root, current: otherProfile }), {
      code: "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
    });
    assert.equal(assetReads, 0);
    await observe({ consumerRoot: fixture.root, current: fixture.current });
    assert.equal(assetReads, 1);
    await assertUnchanged(fixture);
  },
);

sourceScenario(
  "retained verifier requires the real planner to observe current source assets and recovers",
  async (fixture) => {
    const observe = verifier(fixture);
    const skill = join(fixture.root, fixture.current.skillPath);
    await writeFile(skill, "TEST consumer-edited managed skill\n");
    const input = await nodeManagedGeneration2SourceInputReader.read({
      consumerRoot: fixture.root,
    });
    assert.deepEqual(input.desired, fixture.current);
    await assert.rejects(observe({ consumerRoot: fixture.root, current: fixture.current }), {
      code: "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
    });
    await writeFile(skill, fixture.originals.get(fixture.current.skillPath)!);
    await observe({ consumerRoot: fixture.root, current: fixture.current });
    await assertUnchanged(fixture);
  },
);

sourceScenario(
  "preserved source admission excludes successor profiles and unqualified Node pins",
  async (fixture) => {
    const read = () => nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root });
    const profile = join(fixture.root, INTEGRATION_PROFILE_PATH);
    await writeFile(profile, `${JSON.stringify(fixture.target, null, 2)}\n`);
    await assert.rejects(read(), { code: "DOCS_CONSUMER_PROFILE_INVALID" });
    await writeFile(profile, fixture.originals.get(INTEGRATION_PROFILE_PATH)!);
    const pin = join(fixture.root, ".node-version");
    for (const bytes of [
      "26.11.1",
      "26.11.1\r\n",
      "26.11.2\n",
      "26.12.1",
      "26.12.1\r\n",
      "26.12.2\n",
      "25.9.0\n",
      "24.17.0\n",
    ]) {
      await writeFile(pin, bytes);
      await assert.rejects(read(), { code: "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID" });
    }
    const otherQualifiedPin = fixture.sourceNodePin === "26.11.1\n" ? "26.12.1\n" : "26.11.1\n";
    await writeFile(pin, otherQualifiedPin);
    await assert.rejects(read(), { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" });
    await writeFile(pin, fixture.sourceNodePin);
    assert.deepEqual((await read()).desired, fixture.current);
    await assertUnchanged(fixture);
  },
);

sourceScenario(
  "preserved source pin rejects physical mode drift absent from the Git diff",
  async (fixture) => {
    const pin = join(fixture.root, ".node-version");
    await chmod(pin, 0o600);
    assert.equal(git(fixture.root, "diff", "--name-only"), "");
    await assert.rejects(
      nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
      { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
    );
    await chmod(pin, 0o644);
    await verifier(fixture)({ consumerRoot: fixture.root, current: fixture.current });
    await assertUnchanged(fixture);
  },
);

test(
  process.platform === "win32"
    ? "uncommitted host pin admission [Windows runtime refusal]"
    : "preserved source admission requires the Node26 pin in the selected Git image",
  async (context) => {
    const fixture = await retainedFixture(context);
    if (process.platform === "win32") {
      assert.equal(process.versions.node.split(".")[0], "26");
      await assert.rejects(
        nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
        { code: "DOCS_CONSUMER_UNSUPPORTED_NODE" },
      );
      await assertUnchanged(fixture);
      context.diagnostic(
        "Windows default Node26 refusal only; no positive Git-image binding claim.",
      );
      return;
    }
    assert.equal(process.versions.node, "24.22.3");
    const pin = join(fixture.root, ".node-version");
    assert.equal(git(fixture.root, "show", "HEAD:.node-version"), "24.21.0");
    for (const sourceNodePin of ["26.11.1\n", "26.12.1\n"] as const) {
      await writeFile(pin, sourceNodePin);
      await assert.rejects(
        nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
        { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
      );
    }
    await writeFile(pin, fixture.sourceNodePin);
    await verifier(fixture)({ consumerRoot: fixture.root, current: fixture.current });
    await assertUnchanged(fixture);
  },
);

for (const sourceNodePin of ["26.11.1\n", "26.12.1\n"] as const) {
  test(`preserved source restoration requires its verifier before environment resolution or installation [Node${sourceNodePin.trim()}]`, async (context: TestContext) => {
    const fixture = await retainedFixture(context, sourceNodePin);
    let environmentReads = 0;
    const sandbox = new NodeConsumerUpgradeSandbox(() => {
      environmentReads += 1;
      throw new Error("TEST runtime resolution must not start without its verifier");
    });
    const input = { consumerRoot: fixture.root, current: fixture.current };
    await assert.rejects(sandbox.restoreAndVerifyManaged(input), {
      code: "DOCS_CONSUMER_UPGRADE_SOURCE_VERIFIER_REQUIRED",
    });
    await assert.rejects(
      sandbox.restoreCommittedAndVerifyManaged({
        ...input,
        sourceRevision: git(fixture.root, "rev-parse", "HEAD"),
      }),
      {
        code: "DOCS_CONSUMER_UPGRADE_SOURCE_VERIFIER_REQUIRED",
      },
    );
    assert.equal(environmentReads, 0);
    await assert.rejects(lstat(join(fixture.root, "node_modules")), { code: "ENOENT" });
    await assertUnchanged(fixture);
  });
}

sourceScenario(
  "restored source selects original Git bytes while ordinary admission stays bound to current HEAD",
  async (fixture) => {
    const sourceRevision = git(fixture.root, "rev-parse", "HEAD");
    const pin = join(fixture.root, ".node-version");
    const otherPin = fixture.sourceNodePin === "26.11.1\n" ? "26.12.1\n" : "26.11.1\n";
    await writeFile(pin, otherPin);
    git(fixture.root, "add", ".node-version");
    git(fixture.root, "commit", "-qm", "test: commit distinct target pin");
    const currentRevision = git(fixture.root, "rev-parse", "HEAD");
    await writeFile(pin, fixture.sourceNodePin);
    const selected = { consumerRoot: fixture.root, sourceRevision };
    const read = () => nodeManagedGeneration2SourceInputReader.readRestored(selected);
    await assert.rejects(
      Reflect.apply(nodeManagedGeneration2SourceInputReader.read, undefined, [selected]),
      { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
    );
    const observed = await read();
    assert.equal(observed.repositoryHead, currentRevision);
    assert.deepEqual(observed.desired, fixture.current);
    await verifier(fixture)({ ...selected, current: fixture.current });
    const unrelatedRevision = git(
      fixture.root,
      "commit-tree",
      git(fixture.root, "rev-parse", `${sourceRevision}^{tree}`),
      "-m",
      "test: unrelated identical source tree",
    );
    for (const invalidRevision of ["HEAD", "0".repeat(40), currentRevision, unrelatedRevision]) {
      await assert.rejects(
        nodeManagedGeneration2SourceInputReader.readRestored({
          ...selected,
          sourceRevision: invalidRevision,
        }),
        { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
      );
    }
    await assert.rejects(
      Reflect.apply(nodeManagedGeneration2SourceInputReader.readRestored, undefined, [
        { consumerRoot: fixture.root },
      ]),
      { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
    );
    await writeFile(pin, otherPin);
    await assert.rejects(read(), { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" });
    await writeFile(pin, fixture.sourceNodePin);
    await chmod(pin, 0o755);
    await assert.rejects(read(), { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" });
    await chmod(pin, 0o644);
    const profilePath = join(fixture.root, INTEGRATION_PROFILE_PATH);
    const profile = fixture.originals.get(INTEGRATION_PROFILE_PATH)!;
    await writeFile(profilePath, Buffer.concat([Buffer.from(" "), profile]));
    await assert.rejects(read(), { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" });
    await writeFile(profilePath, profile);
    await verifier(fixture)({ ...selected, current: fixture.current });
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), currentRevision);
    await assertUnchanged(fixture);
  },
);

sourceScenario(
  "committed restoration forwards its authenticated source revision before installation",
  async (fixture) => {
    const sourceRevision = git(fixture.root, "rev-parse", "HEAD");
    const observations: string[] = [];
    const sandbox = new NodeConsumerUpgradeSandbox(
      () => {
        throw new Error("TEST stop after retained verification");
      },
      async (options) => {
        assert.equal(options.sourceRevision, sourceRevision);
        observations.push(options.sourceRevision);
        await verifier(fixture)(options);
      },
    );
    await assert.rejects(
      sandbox.restoreCommittedAndVerifyManaged({
        consumerRoot: fixture.root,
        current: fixture.current,
        sourceRevision,
      }),
      /TEST stop after retained verification/u,
    );
    assert.deepEqual(observations, [sourceRevision]);
    await assertUnchanged(fixture);
  },
);

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
scenario(
  "retained preparation keeps exact pin ownership and rejects a forged no-op pin write",
  async (_t, f) => {
    const writesPin = f.plan.operations.some(({ path }) => path === ".node-version");
    assert.equal(writesPin, f.sourceNodePin !== "26.12.1\n");
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
        /unchanged or ambiguously owned replacements are forbidden/u,
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
        f.sourceNodePin === "26.12.1\n"
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
