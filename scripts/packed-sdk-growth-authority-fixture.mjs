import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  archiveIdentity,
  controlledNow,
  digest,
  withinAuthorityDeadline,
} from "./packed-sdk-growth-authority-fixture-values.ts";
import { prepareFixtureContext } from "./packed-sdk-growth-authority-fixture-context.ts";
import { createFixtureTransport } from "./packed-sdk-growth-authority-fixture-transport.ts";
export { observeClosedFixture } from "./packed-sdk-growth-authority-fixture-evidence.ts";

async function assertLegacyProtocolRejected(api, transport, repositoryRoot, binding) {
  const legacy = api.createSdkGrowthAuthorityVerifier(
    {
      ...transport,
      async resolve(request) {
        const grant = JSON.parse(await transport.resolve(request));
        return JSON.stringify({ ...grant, schemaVersion: "reviewrouter:sdk-growth-authority:1" });
      },
    },
    undefined,
    controlledNow,
  );
  let rejected = false;
  try {
    await withinAuthorityDeadline(legacy.qualifyCheck, {
      consumerRoot: repositoryRoot,
      configPath: "policy.yaml",
      binding,
    });
  } catch (error) {
    rejected = error?.reason === "growth-authority-grant-invalid";
  }
  if (!rejected) {
    throw new Error("Packed authority did not explicitly reject protocol v1.");
  }
}

async function assertSuccessfulPackedPromotion(verifier, input, binding, qualified, race) {
  assert.equal(qualified.report.verdict, "admitted");
  assert.equal(qualified.report.releaseEligible, true);
  assert.equal(qualified.receipt.qualification, "qualified");
  const destinations = [
    input.config.packages[0].releasedBaselinePath,
    input.config.packages[0].releasedBaselinePath.replace(/\.json$/u, ".artifacts.json"),
  ];
  const before = await Promise.all(
    destinations.map((path) => readFile(join(input.repositoryRoot, path))),
  );
  const manifestPath = join(input.repositoryRoot, "package.json");
  const originalManifest = await readFile(manifestPath);
  let raceTriggered = false;
  race.mutate = async () => {
    raceTriggered = true;
    await writeFile(manifestPath, Buffer.concat([originalManifest, Buffer.from("\n")]));
  };
  try {
    await assert.rejects(
      withinAuthorityDeadline(verifier.promoteRelease, {
        consumerRoot: input.repositoryRoot,
        configPath: "policy.yaml",
        binding,
        admissionReceiptId: qualified.receipt.receiptId,
      }),
      (error) =>
        error?.reason === "growth-execution-inputs-changed" ||
        (error?.problem?.code === "SDK_GROWTH_EVIDENCE_INCOMPLETE" &&
          error.problem.message === "Source Git checkpoint is unavailable or changed."),
    );
    assert.equal(
      raceTriggered,
      true,
      "The rejecting run must reach asynchronous promotion completion.",
    );
    for (const [index, destination] of destinations.entries()) {
      assert.deepEqual(await readFile(join(input.repositoryRoot, destination)), before[index]);
    }
  } finally {
    race.mutate = undefined;
    await writeFile(manifestPath, originalManifest);
  }
  const promoted = await withinAuthorityDeadline(verifier.promoteRelease, {
    consumerRoot: input.repositoryRoot,
    configPath: "policy.yaml",
    binding,
    admissionReceiptId: qualified.receipt.receiptId,
  });
  const writes = [],
    baselines = [];
  for (const [index, destination] of destinations.entries()) {
    const bytes = await readFile(join(input.repositoryRoot, destination));
    const snapshot = JSON.parse(bytes);
    assert.equal(snapshot.packageVersion, input.candidateVersion);
    assert.equal(snapshot.packageName, input.packageName);
    const expected = structuredClone(index === 0 ? input.expectedTyped : input.expectedArtifact);
    if (index === 0) {
      for (const entry of expected.entrypoints) {
        entry.items.sort((a, b) =>
          a.canonicalReference < b.canonicalReference
            ? -1
            : a.canonicalReference > b.canonicalReference
              ? 1
              : 0,
        );
      }
      assert.deepEqual(snapshot, expected);
    } else {
      assert.deepEqual(bytes, Buffer.from(`${JSON.stringify(expected, null, 2)}\n`));
    }
    assert.notDeepEqual(bytes, before[index]);
    writes.push({
      destination,
      operation: "replace",
      preimageDigest: archiveIdentity(before[index]).archiveDigest,
      proposedDigest: archiveIdentity(bytes).archiveDigest,
    });
    baselines.push({
      destination,
      contentHex: bytes.toString("hex"),
      digest: archiveIdentity(bytes).archiveDigest,
    });
  }
  const plan = {
    binding,
    writes: writes.toSorted((a, b) => (a.destination < b.destination ? -1 : 1)),
  };
  assert.equal(promoted.receipt.operation, "promote-release");
  assert.equal(promoted.receipt.qualification, "qualified");
  assert.equal(promoted.receipt.reportDigest, qualified.receipt.reportDigest);
  assert.deepEqual(promoted.receipt.binding, binding);
  assert.deepEqual(promoted.receipt.promotion, {
    kind: "plan",
    planDigest: digest({ domain: "reviewrouter:sdk-growth-authority:promotion-plan:3", plan }),
  });
  assert.equal(
    archiveIdentity(await readFile(join(input.repositoryRoot, input.config.sdkGrowth.reportPath)))
      .archiveDigest,
    qualified.receipt.reportDigest,
  );
  return {
    admissionReceipt: qualified.receipt,
    receipt: promoted.receipt,
    plan,
    writes,
    baselines,
    raceRejectedWithoutWrites: raceTriggered,
  };
}

export async function assertPackedSdkGrowthAuthorityExecution(input) {
  const requireFromConsumer = createRequire(join(input.installedConsumerRoot, "package.json"));
  const installedManifest = requireFromConsumer.resolve(
    "@agent-teams/engineering-foundation/package.json",
  );
  const manifest = JSON.parse(await readFile(installedManifest));
  const selected = manifest.exports?.["./sdk-growth-authority"];
  const target = typeof selected === "string" ? selected : selected?.import;
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(
      "Packed Foundation manifest does not select the SDK growth authority entrypoint.",
    );
  }
  const entrypoint = join(dirname(installedManifest), target);
  const api = await import(pathToFileURL(entrypoint));
  const overDepth = `${"[".repeat(10000)}0${"]".repeat(10000)}`;
  for (const value of [overDepth, Buffer.from(overDepth)]) {
    assert.throws(
      () => api.decodeRequest(value),
      (error) => error instanceof TypeError && /depth/u.test(error.message),
    );
  }
  const fixture = await prepareFixtureContext(input);
  const { binding, installedInventory } = fixture;
  const { transport, race, admissionReceipt } = createFixtureTransport(api, input, fixture);
  await assertLegacyProtocolRejected(api, transport, input.repositoryRoot, binding);
  const verifier = api.createSdkGrowthAuthorityVerifier(
    transport,
    installedInventory,
    controlledNow,
  );
  const qualified = await withinAuthorityDeadline(verifier.qualifyCheck, {
    consumerRoot: input.repositoryRoot,
    configPath: "policy.yaml",
    binding,
  });
  if (input.positivePromotion) {
    return assertSuccessfulPackedPromotion(verifier, input, binding, qualified, race);
  }
  if (
    qualified.receipt?.qualification !== "not-qualified" ||
    qualified.report?.verdict !== "incomplete"
  ) {
    throw new Error("Packed authority check did not preserve its completed incomplete outcome.");
  }
  let rejected = false;
  try {
    await withinAuthorityDeadline(verifier.promoteRelease, {
      consumerRoot: input.repositoryRoot,
      configPath: "policy.yaml",
      binding,
      admissionReceiptId: admissionReceipt().receiptId,
    });
  } catch (error) {
    rejected =
      /admission-receipt|baseline|promotion/iu.test(String(error?.message)) ||
      error?.reason === "growth-authority-admission-receipt-invalid" ||
      error?.problem?.phase === "public-api-baseline-promotion";
  }
  if (!rejected) {
    throw new Error("Packed authority promotion was not rejected by release preflight.");
  }
  return { qualification: qualified.receipt.qualification, promotionRejected: rejected };
}
