import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  registryPublicationTag,
  registryPublishArguments,
} from "../scripts/registry-publication-policy.mjs";
import {
  exactRegistryArchiveObserved,
  publishWithExactEffectReconciliation,
} from "../scripts/registry-publish-reconciliation.mjs";
import {
  installRegistryConsumerWithRetry,
  registryInstallAttemptPaths,
  registryInstallAttemptPolicy,
  runRegistryPhase,
  seedRegistryInParallel,
} from "../scripts/registry-seed-scheduler.mjs";

const confirmedTimeout = () =>
  Object.assign(new Error("timeout"), {
    killed: true,
    terminationConfirmed: true,
    timedOut: true,
  });

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

test("reconciles only a confirmed publish timeout with the exact registry archive", async () => {
  const archive = Buffer.from("exact archive", "utf8");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const shasum = createHash("sha1").update(archive).digest("hex");
  const publication = {
    archivePath: "/tmp/package.tgz",
    name: "@agent-teams/example",
    registryUrl: "http://127.0.0.1:4873",
    version: "1.2.3",
  };
  const observed = await exactRegistryArchiveObserved({
    ...publication,
    readArchive: async () => archive,
    readVersion: async () => ({
      name: publication.name,
      version: publication.version,
      dist: { integrity, shasum },
    }),
  });
  assert.equal(observed, true);
  assert.equal(await exactRegistryArchiveObserved({
    ...publication,
    readArchive: async () => archive,
    readVersion: async () => ({
      name: publication.name,
      version: publication.version,
      dist: { integrity, shasum: "0".repeat(40) },
    }),
  }), false);

  let observationCalls = 0;
  assert.equal(await publishWithExactEffectReconciliation({
    ...publication,
    observe: async () => {
      observationCalls += 1;
      return true;
    },
    publish: async () => {},
  }), "published");
  assert.equal(observationCalls, 0);
  const result = await publishWithExactEffectReconciliation({
    ...publication,
    observe: async () => true,
    publish: async () => {
      throw confirmedTimeout();
    },
  });
  assert.equal(result, "reconciled");
});

test("publish reconciliation remains fail-closed for uncertain effects", async () => {
  const publication = {
    archivePath: "/tmp/package.tgz",
    name: "@agent-teams/example",
    registryUrl: "http://127.0.0.1:4873",
    version: "1.2.3",
  };
  for (const failure of [
    Object.assign(new Error("ordinary failure"), { timedOut: false }),
    confirmedTimeout(),
  ]) {
    await assert.rejects(
      publishWithExactEffectReconciliation({
        ...publication,
        observe: async () => false,
        publish: async () => {
          throw failure;
        },
      }),
      failure,
    );
  }
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

test("retries one confirmed timeout with fresh bounded install state", async () => {
  const attempts = [];
  const cleaned = [];
  const delayed = [];
  const result = await installRegistryConsumerWithRetry({
    cleanupAttempt: async (context) => cleaned.push(context),
    createAttempt: async (attempt) =>
      registryInstallAttemptPaths("/registry-e2e", attempt),
    delay: async (delayMs) => delayed.push(delayMs),
    runInstall: async (context, options) => {
      attempts.push({ context, options });
      if (options.attempt === 1) {
        throw confirmedTimeout();
      }
      return "installed";
    },
  });

  assert.equal(result, "installed");
  assert.deepEqual(
    attempts.map(({ options }) => options.timeoutMs),
    [120_000, 240_000],
  );
  for (const key of ["consumerRoot", "clientRoot", "cacheRoot", "userConfigPath"]) {
    assert.notEqual(attempts[0].context[key], attempts[1].context[key]);
  }
  assert.equal(
    attempts[0].context.userConfigPath.startsWith(attempts[0].context.consumerRoot),
    false,
  );
  assert.deepEqual(cleaned, [attempts[0].context]);
  assert.deepEqual(delayed, [1_000]);
  assert.deepEqual(registryInstallAttemptPolicy, {
    firstAttemptTimeoutMs: 120_000,
    retryAttemptTimeoutMs: 240_000,
    retryDelayMs: 1_000,
  });
});

test("registry install retry remains fail-closed and bounded", async () => {
  for (const failure of [
    { killed: false, terminationConfirmed: true, timedOut: true },
    { killed: true, terminationConfirmed: false, timedOut: true },
    { killed: true, terminationConfirmed: true, timedOut: false },
    { code: 1, killed: false, timedOut: false },
  ]) {
    let attempts = 0;
    await assert.rejects(
      installRegistryConsumerWithRetry({
        createAttempt: async () => ({}),
        runInstall: async () => {
          attempts += 1;
          throw Object.assign(new Error("failure"), failure);
        },
      }),
    );
    assert.equal(attempts, 1);
  }

  let timeoutAttempts = 0;
  await assert.rejects(
    installRegistryConsumerWithRetry({
      createAttempt: async () => ({}),
      delay: async () => {},
      runInstall: async () => {
        timeoutAttempts += 1;
        throw confirmedTimeout();
      },
    }),
  );
  assert.equal(timeoutAttempts, 2);

  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    installRegistryConsumerWithRetry({
      cleanupAttempt: async () => {
        throw cleanupFailure;
      },
      createAttempt: async () => ({}),
      runInstall: async () => {
        throw confirmedTimeout();
      },
    }),
    cleanupFailure,
  );
});

test("registry phase timing reports pass and timeout failure", async () => {
  const lines = [];
  const passTimes = [10, 35];
  assert.equal(
    await runRegistryPhase("registry-seed", async () => "seeded", {
      now: () => passTimes.shift(),
      write: (line) => lines.push(line),
    }),
    "seeded",
  );
  const failureTimes = [40, 160];
  await assert.rejects(
    runRegistryPhase(
      "consumer-install-attempt-1",
      async () => {
        throw confirmedTimeout();
      },
      {
        now: () => failureTimes.shift(),
        write: (line) => lines.push(line),
      },
    ),
    (error) => error?.timedOut === true,
  );
  assert.deepEqual(lines, [
    "Registry E2E phase=registry-seed status=START.\n",
    "Registry E2E phase=registry-seed status=PASS durationMs=25.\n",
    "Registry E2E phase=consumer-install-attempt-1 status=START.\n",
    "Registry E2E phase=consumer-install-attempt-1 status=FAIL durationMs=120 timedOut=true.\n",
  ]);
});

test("registry seed preserves executable members without changing source manifests", { skip: process.platform === "win32" }, async t => {
  const { mkdtemp, mkdir, writeFile, readFile, stat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const { packPackage } = await import("../scripts/registry-install-e2e.mjs");
  const { createPnpmRunner } = await import("../scripts/pack-test-support.mjs");
  const root = await mkdtemp(join(tmpdir(), "TEST-registry-seed-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(join(source, "lib"), { recursive: true });
  const bytes = JSON.stringify({ name: "seed-mode-fixture", version: "1.0.0", files: ["tsrs", "lib"] });
  await writeFile(join(source, "package.json"), bytes);
  for (const member of ["tsrs", "lib/tsc"]) { await writeFile(join(source, member), "native fixture", { mode: 0o755 }); }
  const archive = await packPackage({ root: source, identity: "seed-mode-fixture@1.0.0" }, 0,
    { temporaryRoot: root, runPnpm: createPnpmRunner() });
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  await promisify(execFile)("tar", ["-xzf", archive, "-C", extracted]);
  for (const member of ["tsrs", "lib/tsc"]) {
    assert.notEqual((await stat(join(extracted, "package", member))).mode & 0o111, 0);
    assert.notEqual((await stat(join(source, member))).mode & 0o111, 0);
  }
  assert.equal(await readFile(join(source, "package.json"), "utf8"), bytes);
});

test("registry executable inventory refuses its entry bound", async t => {
  const { seedExecutableFiles } = await import("../scripts/registry-install-e2e.mjs");
  const { tmpdir } = await import("node:os");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "TEST-seed-entry-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "entry"), "fixture");
  await assert.rejects(seedExecutableFiles(root, root, { entries: 50_000 }), /exceeds its bound/u);
});
