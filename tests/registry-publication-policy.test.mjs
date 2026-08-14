import assert from "node:assert/strict";
import test from "node:test";

import {
  registryPublicationTag,
  registryPublishArguments,
} from "../scripts/registry-publication-policy.mjs";
import { seedRegistryInParallel } from "../scripts/registry-seed-scheduler.mjs";

test("keeps stable hermetic registry publications on the default tag", () => {
  assert.equal(registryPublicationTag("0.16.0"), undefined);
  assert.doesNotMatch(
    registryPublishArguments({
      archivePath: "package.tgz",
      registryUrl: "http://127.0.0.1:4873",
      version: "0.16.0",
    }).join(" "),
    /--tag/u,
  );
});

test("routes prerelease publications to a non-latest hermetic tag", () => {
  assert.equal(registryPublicationTag("0.16.0-rc.0"), "e2e-prerelease");
  assert.deepEqual(
    registryPublishArguments({
      archivePath: "package.tgz",
      registryUrl: "http://127.0.0.1:4873",
      version: "0.16.0-rc.0",
    }).slice(-2),
    ["--tag", "e2e-prerelease"],
  );
});

test("rejects a missing package version", () => {
  assert.throws(
    () => registryPublicationTag(""),
    /requires a package version/u,
  );
});

test("seeds distinct packages concurrently while serializing package versions", async () => {
  const events = [];
  let activeCommands = 0;
  let maximumActiveCommands = 0;
  const dependencies = [
    { manifest: { name: "alpha", version: "1.0.0" } },
    { manifest: { name: "beta", version: "1.0.0" } },
    { manifest: { name: "alpha", version: "2.0.0" } },
    { manifest: { name: "gamma", version: "1.0.0" } },
  ];
  async function recordCommand(event) {
    activeCommands += 1;
    maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
    events.push(`start:${event}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    events.push(`end:${event}`);
    activeCommands -= 1;
  }

  await seedRegistryInParallel({
    concurrency: 2,
    dependencies,
    packPackage: async (entry, index) => {
      const identity = `${entry.manifest.name}@${entry.manifest.version}`;
      await recordCommand(`pack:${identity}`);
      return `${index}-${identity}.tgz`;
    },
    publishArchive: async (archivePath) => {
      await recordCommand(`publish:${archivePath}`);
    },
    registryUrl: "http://127.0.0.1:4873",
  });

  assert.equal(maximumActiveCommands, 2);
  assert.ok(
    events.indexOf("end:publish:0-alpha@1.0.0.tgz") <
      events.indexOf("start:pack:alpha@2.0.0"),
  );
});

test("rejects unsafe registry seed concurrency", async () => {
  await assert.rejects(
    seedRegistryInParallel({
      concurrency: 0,
      dependencies: [],
      packPackage: async () => "unused.tgz",
      publishArchive: async () => {},
      registryUrl: "http://127.0.0.1:4873",
    }),
    /positive integer/u,
  );
});

test("waits for active registry seed workers before reporting a failure", async () => {
  let secondWorkerFinished = false;
  await assert.rejects(
    seedRegistryInParallel({
      concurrency: 2,
      dependencies: [
        { manifest: { name: "alpha", version: "1.0.0" } },
        { manifest: { name: "beta", version: "1.0.0" } },
      ],
      packPackage: async (entry) => {
        if (entry.manifest.name === "alpha") {
          throw new Error("seed failed");
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
        secondWorkerFinished = true;
        return "beta.tgz";
      },
      publishArchive: async () => {},
      registryUrl: "http://127.0.0.1:4873",
    }),
    /seed failed/u,
  );
  assert.equal(secondWorkerFinished, true);
});
