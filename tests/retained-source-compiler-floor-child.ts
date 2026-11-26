import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { withPublishedCompilerFloor } from "../scripts/published-foundation-imports.ts";

const [mode, consumerRoot, selectedProfileJson, compilerAlias] = process.argv.slice(2);
assert.equal(process.argv.length, 6);
assert.ok(mode === "observe" || mode === "catch-denial");
assert.equal(typeof consumerRoot, "string");
assert.equal(typeof selectedProfileJson, "string");
assert.equal(typeof compilerAlias, "string");
assert.ok(consumerRoot && selectedProfileJson && compilerAlias);
assert.equal(process.versions.node, "24.21.0");

let caughtDenial = false;
try {
  await withPublishedCompilerFloor(async () => {
    if (mode === "catch-denial") {
      try {
        await import(pathToFileURL(compilerAlias).href);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(error.message, /compiler\/extractor loading is forbidden/u);
        caughtDenial = true;
        process.stderr.write("TEST_RETAINED_SOURCE_COMPILER_DENIAL_CAUGHT\n");
      }
      assert.equal(
        caughtDenial,
        true,
        "The synthetic compiler alias must be rejected before evaluation.",
      );
    }
    const { nodeManagedGeneration2SourceInputReader } =
      await import("../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/node-consumer-integration-repository.js");
    const { createRetainedGeneration2SourceVerifier } =
      await import("../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/node-retained-source-verifier.js");
    const { packageConsumerAssetCatalogReader } =
      await import("../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/package-consumer-asset-catalog.js");
    const { consumerIntegrationPlanningPorts } =
      await import("../packages/docs-protocol-agent-teams/dist/consumer-integration/composition/consumer-integration-planner.js");
    const { desired } = await nodeManagedGeneration2SourceInputReader.read({ consumerRoot });
    assert.ok(desired.schemaVersion === 3);
    const selected: unknown = JSON.parse(selectedProfileJson);
    assert.deepEqual(desired, selected);
    await createRetainedGeneration2SourceVerifier({
      input: nodeManagedGeneration2SourceInputReader,
      assets: packageConsumerAssetCatalogReader,
      planning: consumerIntegrationPlanningPorts,
    })({ consumerRoot, current: desired });
  });
  // The parent accepts success only after the entire guarded observation resolves.
  process.stdout.write("TEST_RETAINED_SOURCE_GUARDED_COMPLETE\n");
} catch (error) {
  if (
    mode === "catch-denial" &&
    caughtDenial &&
    error instanceof Error &&
    /compiler floor guard refused/u.test(error.message)
  ) {
    process.stderr.write("TEST_RETAINED_SOURCE_STICKY_GUARD_REFUSED\n");
    process.exitCode = 86;
  } else {
    throw error;
  }
}
