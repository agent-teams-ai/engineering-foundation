import assert from "node:assert/strict";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { nodeManagedGeneration2SourceInputReader } from "../dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import { NodeConsumerUpgradeSandbox } from "../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";
import { INTEGRATION_PROFILE_PATH } from "../dist/consumer-integration/adapters/node-consumer-repository-files.js";
import { packageConsumerAssetCatalogReader } from "../dist/consumer-integration/adapters/package-consumer-asset-catalog.js";
import { createRetainedGeneration2SourceVerifier } from "../dist/consumer-integration/adapters/node-retained-source-verifier.js";
import { fixtureGit as git, retainedFixture } from "./managed-restoration-fixture.ts";

type Fixture = Awaited<ReturnType<typeof retainedFixture>>;

function sourceScenario(name: string, run: (fixture: Fixture) => Promise<void>): void {
  void test(
    process.platform === "win32" ? `${name} [Windows runtime refusal]` : name,
    async (context) => {
      const fixture = await retainedFixture(context, "26.11.1\n");
      if (process.platform === "win32") {
        assert.equal(process.versions.node.split(".")[0], "26");
        await assert.rejects(
          nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
          { code: "DOCS_CONSUMER_UNSUPPORTED_NODE" },
        );
        await assertUnchanged(fixture);
        context.diagnostic("Windows default Node26 refusal only; no positive source observation claim.");
        return;
      }
      assert.equal(process.versions.node, "24.21.0", "Select the physical retained-controller test runtime.");
      await run(fixture);
    },
  );
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

sourceScenario("retained verifier compares the complete original profile before consulting assets", async (fixture) => {
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
  const otherProfile = { ...fixture.current, profilePath: "architecture/foundation/other-docs.yaml" };
  assert.deepEqual(otherProfile.cohort, fixture.current.cohort);
  await assert.rejects(
    observe({ consumerRoot: fixture.root, current: otherProfile }),
    { code: "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT" },
  );
  assert.equal(assetReads, 0);
  await observe({ consumerRoot: fixture.root, current: fixture.current });
  assert.equal(assetReads, 1);
  await assertUnchanged(fixture);
});

sourceScenario("retained verifier requires the real planner to observe current source assets and recovers", async (fixture) => {
  const observe = verifier(fixture);
  const skill = join(fixture.root, fixture.current.skillPath);
  await writeFile(skill, "TEST consumer-edited managed skill\n");
  const input = await nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root });
  assert.deepEqual(input.desired, fixture.current);
  await assert.rejects(
    observe({ consumerRoot: fixture.root, current: fixture.current }),
    { code: "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT" },
  );
  await writeFile(skill, fixture.originals.get(fixture.current.skillPath)!);
  await observe({ consumerRoot: fixture.root, current: fixture.current });
  await assertUnchanged(fixture);
});

sourceScenario("preserved source admission excludes successor profiles and unqualified Node pins", async (fixture) => {
  const read = () => nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root });
  const profile = join(fixture.root, INTEGRATION_PROFILE_PATH);
  await writeFile(profile, `${JSON.stringify(fixture.target, null, 2)}\n`);
  await assert.rejects(read(), { code: "DOCS_CONSUMER_PROFILE_INVALID" });
  await writeFile(profile, fixture.originals.get(INTEGRATION_PROFILE_PATH)!);
  const pin = join(fixture.root, ".node-version");
  for (const bytes of ["26.11.1", "26.11.1\r\n", "26.11.2\n", "25.9.0\n", "24.17.0\n"]) {
    await writeFile(pin, bytes);
    await assert.rejects(read(), { code: "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID" });
  }
  await writeFile(pin, fixture.sourceNodePin);
  assert.deepEqual((await read()).desired, fixture.current);
  await assertUnchanged(fixture);
});

sourceScenario("preserved source pin rejects physical mode drift absent from the Git diff", async (fixture) => {
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
});

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
      context.diagnostic("Windows default Node26 refusal only; no positive Git-image binding claim.");
      return;
    }
    assert.equal(process.versions.node, "24.21.0");
    const pin = join(fixture.root, ".node-version");
    await writeFile(pin, "26.11.1\n");
    assert.equal(git(fixture.root, "show", "HEAD:.node-version"), "24.21.0");
    await assert.rejects(
      nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
      { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" },
    );
    await writeFile(pin, fixture.sourceNodePin);
    await verifier(fixture)({ consumerRoot: fixture.root, current: fixture.current });
    await assertUnchanged(fixture);
  },
);

test("preserved source restoration requires its verifier before environment resolution or installation", async (context: TestContext) => {
  const fixture = await retainedFixture(context, "26.11.1\n");
  let environmentReads = 0;
  const sandbox = new NodeConsumerUpgradeSandbox(() => {
    environmentReads += 1;
    throw new Error("TEST runtime resolution must not start without its verifier");
  });
  const input = { consumerRoot: fixture.root, current: fixture.current };
  await assert.rejects(sandbox.restoreAndVerifyManaged(input), {
    code: "DOCS_CONSUMER_UPGRADE_SOURCE_VERIFIER_REQUIRED",
  });
  await assert.rejects(sandbox.restoreCommittedAndVerifyManaged(input), {
    code: "DOCS_CONSUMER_UPGRADE_SOURCE_VERIFIER_REQUIRED",
  });
  assert.equal(environmentReads, 0);
  await assert.rejects(lstat(join(fixture.root, "node_modules")), { code: "ENOENT" });
  await assertUnchanged(fixture);
});
