import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  changesetsPublishArguments,
  main,
  releasePublishInvocation,
  releasePublishDecision,
  releasePublishPolicy,
  releaseState,
} from "../scripts/release-publish.mjs";

const foundation = {
  name: "@agent-teams/engineering-foundation",
  version: "0.16.0",
};
const privateSpike = {
  name: "@agent-teams/source-dependency-parser-spike",
  version: "0.0.0",
};
const freshPreState = {
  mode: "pre",
  tag: "rc",
  initialVersions: {
    [foundation.name]: foundation.version,
    [privateSpike.name]: privateSpike.version,
  },
  changesets: [],
};

function freshDecisionInput() {
  return {
    inventory: {
      metadata: ["README.md", "config.json", "pre.json"],
      pending: [],
      unexpected: [],
    },
    packages: { private: [privateSpike], public: [foundation] },
    preState: freshPreState,
  };
}

test("skips only an exact fresh prerelease state for the complete public package set", () => {
  const input = freshDecisionInput();
  assert.deepEqual(releasePublishDecision(input), { action: "noop" });
  for (const unsafe of [
    { ...input, inventory: { ...input.inventory, pending: ["release.md"] } },
    { ...input, inventory: { ...input.inventory, unexpected: ["foreign.txt"] } },
    { ...input, preState: { ...freshPreState, changesets: ["release"] } },
    {
      ...input,
      preState: {
        ...freshPreState,
        initialVersions: { ...freshPreState.initialVersions, [foundation.name]: "0.15.0" },
      },
    },
    {
      ...input,
      preState: {
        ...freshPreState,
        initialVersions: { ...freshPreState.initialVersions, "@unknown/public": "1.0.0" },
      },
    },
    { ...input, inventory: { ...input.inventory, metadata: ["config.json", "pre.json"] } },
    {
      ...input,
      inventory: {
        ...input.inventory,
        metadata: [".ignored.md", "README.md", "config.json", "pre.json"],
      },
    },
  ]) {
    assert.throws(() => releasePublishDecision(unsafe), /publication|Prerelease/u);
  }
  assert.deepEqual(
    releasePublishDecision({
      ...input,
      packages: {
        ...input.packages,
        public: [{ ...foundation, version: "0.17.0-rc.0" }],
      },
    }),
    { action: "publish", tag: "rc" },
  );
  const rcInput = {
    ...input,
    packages: {
      ...input.packages,
      public: [{ ...foundation, required: true, version: "0.17.0-rc.0" }],
    },
  };
  for (const initialVersions of [
    { [foundation.name]: foundation.version },
    { ...freshPreState.initialVersions, "@unknown/package": "1.0.0" },
  ]) {
    assert.throws(
      () =>
        releasePublishDecision({
          ...rcInput,
          preState: { ...freshPreState, initialVersions },
        }),
      /Prerelease publication/u,
    );
  }
  for (const malformedPreState of [
    { mode: "pre", tag: "rc", initialVersions: freshPreState.initialVersions },
    { ...freshPreState, changesets: 42 },
    { ...freshPreState, extra: true },
  ]) {
    assert.throws(
      () => releasePublishDecision({ ...rcInput, preState: malformedPreState }),
      /Prerelease publication/u,
    );
  }
  assert.throws(
    () =>
      releasePublishDecision({
        inventory: { ...input.inventory, metadata: ["README.md", "config.json"] },
        packages: { private: [], public: [{ ...foundation, version: "0.17.0-rc.0" }] },
        preState: undefined,
      }),
    /strict SemVer release versions/u,
  );
  for (const version of ["0.1.0-rc.0", "0.17.0-rc.01", "0.17.0-rc.0+build.1"]) {
    assert.throws(
      () =>
        releasePublishDecision({
          ...input,
          packages: {
            ...input.packages,
            public: [{ ...foundation, required: true, version }],
          },
        }),
      /Prerelease publication/u,
    );
  }
});

test("routes an exact Changesets rc version to the rc npm dist-tag", () => {
  assert.deepEqual(
    releasePublishPolicy({
      packageVersion: "0.16.0-rc.0",
      preState: { mode: "pre", tag: "rc" },
    }),
    { tag: "rc" },
  );
  assert.deepEqual(changesetsPublishArguments(), ["changeset", "publish"]);
});

test("resolves release publishing without shell mode on Windows", () => {
  assert.deepEqual(
    releasePublishInvocation({ commandInterpreter: "C:\\Windows\\System32\\cmd.exe", platform: "win32" }),
    {
      args: ["/d", "/s", "/c", "pnpm.cmd changeset publish"],
      command: "C:\\Windows\\System32\\cmd.exe",
    },
  );
  assert.deepEqual(releasePublishInvocation({ platform: "linux" }), {
    args: ["changeset", "publish"],
    command: "pnpm",
  });
});

test("keeps ordinary stable releases on the default dist-tag", () => {
  assert.deepEqual(
    releasePublishPolicy({ packageVersion: "0.16.0", preState: undefined }),
    { tag: undefined },
  );
  assert.deepEqual(changesetsPublishArguments(), ["changeset", "publish"]);
});

for (const scenario of [
  { name: "prerelease without state", version: "0.16.0-rc.0", state: undefined },
  { name: "wrong prerelease tag", version: "0.16.0-beta.0", state: { mode: "pre", tag: "beta" } },
  { name: "malformed rc version", version: "0.16.0-rc.next", state: { mode: "pre", tag: "rc" } },
  { name: "stable version in pre mode", version: "0.16.0", state: { mode: "pre", tag: "rc" } },
  { name: "exited pre mode", version: "0.16.0-rc.0", state: { mode: "exit", tag: "rc" } },
]) {
  test(`fails closed for ${scenario.name}`, () => {
    assert.throws(
      () => releasePublishPolicy({ packageVersion: scenario.version, preState: scenario.state }),
      /publication|Prerelease/u,
    );
  });
}

const releaseScript = fileURLToPath(new URL("../scripts/release-publish.mjs", import.meta.url));
const changesetsCli = fileURLToPath(new URL("../node_modules/@changesets/cli/bin.js", import.meta.url));
const noop = async () => {};

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function commandShim(root, name, { posix, windows }, platform = process.platform) {
  const isWindows = platform === "win32";
  const path = join(root, "bin", `${name}${isWindows ? ".cmd" : ""}`);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "home", "global.npmrc"), ""),
    writeFile(join(root, "home", "user.npmrc"), ""),
  ]);
  await writeFile(path, isWindows ? windows : posix);
  if (!isWindows) {
    await chmod(path, 0o755);
  }
  return path;
}

function commandEnvironment(
  root,
  publishMarker,
  platform = process.platform,
  baseEnvironment = process.env,
) {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([key]) => {
      const normalized = key.toLowerCase();
      return !["home", "homedrive", "homepath", "path", "pathext", "userprofile"].includes(normalized) &&
        !normalized.startsWith("npm_") &&
        !normalized.startsWith("pnpm_") && !normalized.startsWith("corepack_");
    }),
  );
  const isolatedHome = join(root, "home");
  environment[platform === "win32" ? "Path" : "PATH"] = join(root, "bin");
  environment.COMMAND_SHIM_MARKER = join(root, "command-shim.marker");
  environment.HOME = isolatedHome;
  environment.NPM_CONFIG_GLOBALCONFIG = join(isolatedHome, "global.npmrc");
  environment.NPM_CONFIG_USERCONFIG = join(isolatedHome, "user.npmrc");
  if (platform === "win32") {
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  environment.PUBLISH_MARKER = publishMarker;
  environment.USERPROFILE = isolatedHome;
  return environment;
}

test("canonicalizes Windows PATH and removes inherited package-manager routing", () => {
  const environment = commandEnvironment(
    "C:\\fixture",
    "C:\\publish.marker",
    "win32",
    {
      COREPACK_HOME: "C:\\corepack",
      HOME: "C:\\real-home",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\real-home",
      npm_config_user_agent: "pnpm/10",
      npm_execpath: "C:\\real\\npm-cli.js",
      PATH: "C:\\wrong",
      Path: "C:\\inherited",
      pathext: ".EXE",
      SAFE_VALUE: "kept",
      USERPROFILE: "C:\\real-profile",
    },
  );
  assert.deepEqual(Object.keys(environment).filter((key) => key.toLowerCase() === "path"), ["Path"]);
  assert.equal(environment.Path, join("C:\\fixture", "bin"));
  assert.deepEqual(Object.keys(environment).filter((key) => key.toLowerCase() === "pathext"), ["PATHEXT"]);
  assert.equal(environment.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(environment.HOME, join("C:\\fixture", "home"));
  assert.equal(environment.USERPROFILE, environment.HOME);
  assert.equal(environment.HOMEDRIVE, undefined);
  assert.equal(environment.HOMEPATH, undefined);
  assert.equal(environment.NPM_CONFIG_USERCONFIG, join(environment.HOME, "user.npmrc"));
  assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, join(environment.HOME, "global.npmrc"));
  assert.equal(environment.SAFE_VALUE, "kept");
  assert.equal(
    Object.keys(environment).some((key) =>
      /^(?:pnpm|corepack)_/iu.test(key) || (/^npm_/iu.test(key) && !/npm_config_(?:user|global)config/iu.test(key))),
    false,
  );
});

test("creates one platform-native command shim without a shadowing extensionless file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-command-shim-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const windowsPath = await commandShim(
    root,
    "npm",
    { posix: "posix\n", windows: "@echo windows\r\n" },
    "win32",
  );
  assert.equal(windowsPath, join(root, "bin", "npm.cmd"));
  assert.equal(await readFile(windowsPath, "utf8"), "@echo windows\r\n");
  await assert.rejects(readFile(join(root, "bin", "npm")), { code: "ENOENT" });
});

async function runRelease(root, marker) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [releaseScript], {
      cwd: root,
      env: commandEnvironment(root, marker),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
}

async function runChangesets(root, marker, arguments_) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [changesetsCli, ...arguments_], {
      cwd: root,
      env: commandEnvironment(root, marker),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
}

async function fixture(root, registry) {
  await json(join(root, "package.json"), {
    name: "release-fixture",
    private: true,
    workspaces: ["packages/*", "spikes/*"],
  });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - spikes/*\n");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  await writeFile(join(root, ".node-version"), "24.6.0\n");
  await json(join(root, "packages/engineering-foundation/package.json"), {
    ...foundation,
    publishConfig: { registry },
  });
  await writeFile(join(root, "packages/engineering-foundation/dist.js"), "export const build = 1;\n");
  await json(join(root, "spikes/source-dependency-parser/package.json"), {
    ...privateSpike,
    private: true,
  });
  await json(join(root, ".changeset/config.json"), {});
  await writeFile(join(root, ".changeset/README.md"), "metadata\n");
  await json(join(root, ".changeset/pre.json"), freshPreState);
  await commandShim(root, "pnpm", {
    posix:
      "#!/bin/sh\n[ -n \"$COMMAND_SHIM_MARKER\" ] || exit 97\nprintf 'pnpm %s\\n' \"$*\" >> \"$COMMAND_SHIM_MARKER\"\nprintf '%s' \"$*\" > \"$PUBLISH_MARKER\"\n",
    windows:
      "@echo off\r\nif not defined COMMAND_SHIM_MARKER exit /b 97\r\n>> \"%COMMAND_SHIM_MARKER%\" echo pnpm %*\r\n<nul set /p =%* > \"%PUBLISH_MARKER%\"\r\nexit /b 0\r\n",
  });
}

async function changesetsFixture(root) {
  await json(join(root, "package.json"), {
    name: "release-fixture",
    packageManager: "npm@11.16.0",
    private: true,
    workspaces: ["packages/*"],
  });
  await json(join(root, "packages/engineering-foundation/package.json"), {
    name: foundation.name,
    publishConfig: { access: "public", registry: "http://127.0.0.1:9/" },
    version: "0.17.0-rc.0",
  });
  await json(join(root, ".changeset/config.json"), {
    access: "public",
    baseBranch: "main",
    changelog: false,
    commit: false,
    fixed: [],
    ignore: [],
    linked: [],
    updateInternalDependencies: "patch",
  });
  await json(join(root, ".changeset/pre.json"), {
    changesets: [],
    initialVersions: {},
    mode: "pre",
    tag: "rc",
  });
  await commandShim(root, "npm", {
    posix:
      "#!/bin/sh\n[ -n \"$COMMAND_SHIM_MARKER\" ] || exit 97\nprintf 'npm %s\\n' \"$*\" >> \"$COMMAND_SHIM_MARKER\"\nif [ \"$1\" = profile ]; then printf '{}\\n'; exit 0; fi\nif [ \"$1\" = info ]; then exit 0; fi\nif [ \"$1\" = publish ]; then printf '%s' \"$*\" > \"$PUBLISH_MARKER\"; printf '{\"id\":\"foundation\"}\\n'; exit 0; fi\nexit 1\n",
    windows:
      "@echo off\r\nif not defined COMMAND_SHIM_MARKER exit /b 97\r\n>> \"%COMMAND_SHIM_MARKER%\" echo npm %*\r\nif \"%1\"==\"profile\" (echo {}& exit /b 0)\r\nif \"%1\"==\"info\" exit /b 0\r\nif \"%1\"==\"publish\" (<nul set /p =%* > \"%PUBLISH_MARKER%\"& echo {\"id\":\"foundation\"}& exit /b 0)\r\nexit /b 1\r\n",
  });
}

test("pinned Changesets CLI derives rc and rejects a custom tag in pre mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foundation-changesets-cli-"));
  const marker = join(root, "publish.marker");
  t.after(() => rm(root, { force: true, recursive: true }));
  await changesetsFixture(root);
  const derived = await runChangesets(root, marker, ["publish", "--no-git-tag"]);
  const shimCalls = await readFile(join(root, "command-shim.marker"), "utf8");
  assert.match(shimCalls, /^npm "?info"? "?@agent-teams\/engineering-foundation"?\s/mu);
  assert.match(shimCalls, /^npm "?publish"?\s/mu);
  assert.doesNotMatch(shimCalls, /^pnpm /mu);
  assert.equal(derived.status, 0, `${derived.stdout}\n${derived.stderr}`);
  assert.match(await readFile(marker, "utf8"), /publish .*--tag rc/u);
  const custom = await runChangesets(root, marker, [
    "publish",
    "--no-git-tag",
    "--tag",
    "rc",
  ]);
  assert.notEqual(custom.status, 0);
  assert.match(`${custom.stdout}\n${custom.stderr}`, /custom tag is not allowed in pre mode/iu);
});

test("publish entrypoint independently rejects every publish-control drift boundary", async (t) => {
  const mutations = {
    changesets: (root) => json(join(root, ".changeset/config.json"), { access: "restricted" }),
    manifest: async (root, manifest, manifestPath) => {
      manifest.publishConfig.directory = "dist";
      await json(manifestPath, manifest);
    },
    payload: (root) =>
      writeFile(join(root, "packages/engineering-foundation/dist.js"), "export const build = 2;\n"),
    workspace: (root) =>
      writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/other-*\n"),
  };
  for (const [boundary, mutate] of Object.entries(mutations)) {
    const root = await mkdtemp(join(tmpdir(), `foundation-publish-${boundary}-drift-`));
    t.after(() => rm(root, { force: true, recursive: true }));
    await fixture(root, "http://127.0.0.1:1/");
    const manifestPath = join(root, "packages/engineering-foundation/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "0.17.0-rc.0";
    await json(manifestPath, manifest);
    let inspections = 0;
    let spawned = false;
    await assert.rejects(
      main({
        cwd: root,
        inspectReleaseState: async (repositoryRoot) => {
          inspections += 1;
          if (inspections === 2) {
            await mutate(root, manifest, manifestPath);
          }
          return await releaseState(repositoryRoot);
        },
        spawn: () => {
          spawned = true;
          return { status: 0 };
        },
        verifyRegistry: noop,
      }),
      /filesystem state changed before the publish command|workspace package globs/u,
      boundary,
    );
    assert.equal(spawned, false, boundary);
  }
});

test("real release entrypoint proves multi-package registry state and fails closed on drift", async (t) => {
  const versions = new Map([[foundation.name, new Set([foundation.version])]]);
  let registryRequestHook = noop;
  const registry = createServer(async (request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    await registryRequestHook(name);
    const available = versions.get(name) ?? new Set();
    if (available.size === 0) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ versions: Object.fromEntries([...available].map((version) => [version, {}])) }),
    );
  });
  await new Promise((resolve) => {
    registry.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => registry.close());
  const address = registry.address();
  assert.notEqual(address, null);
  const registryUrl = `http://127.0.0.1:${address.port}/`;

  async function scenario(name, mutate, expectedPattern) {
    const root = await mkdtemp(join(tmpdir(), `foundation-release-${name}-`));
    const marker = join(root, "publish.marker");
    t.after(() => rm(root, { force: true, recursive: true }));
    await fixture(root, registryUrl);
    await mutate(root);
    const result = await runRelease(root, marker);
    assert.match(`${result.stdout}\n${result.stderr}`, expectedPattern);
    return { marker, result, root };
  }

  const noOp = await scenario("noop", async () => {}, /publish skipped/u);
  assert.equal(noOp.result.status, 0);
  await assert.rejects(readFile(noOp.marker), { code: "ENOENT" });

  versions.get(foundation.name).delete(foundation.version);
  const absent = await scenario(
    "registry-miss",
    async () => {},
    /requires .*engineering-foundation@0\.16\.0/u,
  );
  assert.notEqual(absent.result.status, 0);
  await assert.rejects(readFile(absent.marker), { code: "ENOENT" });
  versions.get(foundation.name).add(foundation.version);

  versions.get(foundation.name).add("0.17.0-rc.1");
  const downgrade = await scenario(
    "registry-downgrade",
    (root) =>
      json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        publishConfig: { registry: registryUrl },
        version: "0.17.0-rc.0",
      }),
    /not registry-monotonic/u,
  );
  assert.notEqual(downgrade.result.status, 0);
  await assert.rejects(readFile(downgrade.marker), { code: "ENOENT" });
  versions.get(foundation.name).delete("0.17.0-rc.1");

  versions.get(foundation.name).clear();
  versions.get(foundation.name).add("0.17.0-rc.0");
  const onlyPre = await scenario(
    "only-pre",
    (root) =>
      json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        publishConfig: { registry: registryUrl },
        version: "0.17.0-rc.1",
      }),
    /cannot safely preserve the rc tag/u,
  );
  assert.notEqual(onlyPre.result.status, 0);
  await assert.rejects(readFile(onlyPre.marker), { code: "ENOENT" });

  const onlyPreExisting = await scenario(
    "only-pre-existing",
    (root) =>
      json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        publishConfig: { registry: registryUrl },
        version: "0.17.0-rc.0",
      }),
    /cannot safely preserve the rc tag/u,
  );
  assert.notEqual(onlyPreExisting.result.status, 0);
  await assert.rejects(readFile(onlyPreExisting.marker), { code: "ENOENT" });
  versions.get(foundation.name).clear();
  versions.get(foundation.name).add(foundation.version);

  const liveDrift = await scenario(
    "live-state-drift",
    async (root) => {
      registryRequestHook = async () => {
        registryRequestHook = noop;
        const path = join(root, ".changeset/pre.json");
        const state = JSON.parse(await readFile(path, "utf8"));
        state.changesets = ["appeared-during-registry-check"];
        await json(path, state);
      };
    },
    /filesystem state changed/u,
  );
  assert.notEqual(liveDrift.result.status, 0);
  await assert.rejects(readFile(liveDrift.marker), { code: "ENOENT" });

  let registryChecks = 0;
  registryRequestHook = async () => {
    registryChecks += 1;
    if (registryChecks === 2) {
      versions.get(foundation.name).add("0.17.0-rc.1");
    }
  };
  const registryRace = await scenario(
    "registry-race",
    (root) =>
      json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        publishConfig: { registry: registryUrl },
        version: "0.17.0-rc.0",
      }),
    /not registry-monotonic|registry state changed/u,
  );
  assert.notEqual(registryRace.result.status, 0);
  await assert.rejects(readFile(registryRace.marker), { code: "ENOENT" });
  registryRequestHook = noop;
  versions.get(foundation.name).delete("0.17.0-rc.1");

  let finalFilesystemChecks = 0;
  const finalFilesystemRace = await scenario(
    "final-filesystem-race",
    async (root) => {
      await json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        publishConfig: { registry: registryUrl },
        version: "0.17.0-rc.0",
      });
      registryRequestHook = async () => {
        finalFilesystemChecks += 1;
        if (finalFilesystemChecks === 2) {
          await writeFile(
            join(root, "packages/engineering-foundation/dist.js"),
            "export const build = 3;\n",
          );
        }
      };
    },
    /filesystem state changed during final registry verification/u,
  );
  assert.notEqual(finalFilesystemRace.result.status, 0);
  await assert.rejects(readFile(finalFilesystemRace.marker), { code: "ENOENT" });
  registryRequestHook = noop;

  versions.get(foundation.name).add("0.18.0");
  const stableRollback = await scenario(
    "stable-rollback",
    async (root) => {
      await rm(join(root, ".changeset/pre.json"));
      await json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        publishConfig: { registry: registryUrl },
        version: "0.17.0",
      });
    },
    /not registry-monotonic/u,
  );
  assert.notEqual(stableRollback.result.status, 0);
  await assert.rejects(readFile(stableRollback.marker), { code: "ENOENT" });
  versions.get(foundation.name).delete("0.18.0");

  for (const [name, mutate] of [
    [
      "missing-required-foundation",
      (root) => rm(join(root, "packages/engineering-foundation"), { force: true, recursive: true }),
    ],
    ["unexpected-entry", (root) => writeFile(join(root, ".changeset/foreign.txt"), "drift\n")],
    [
      "legacy-v1",
      async (root) => {
        await json(join(root, ".changeset/legacy/changes.json"), { releases: [] });
        await writeFile(join(root, ".changeset/legacy/changes.md"), "legacy\n");
      },
    ],
    [
      "state-drift",
      async (root) => {
        const path = join(root, ".changeset/pre.json");
        const state = JSON.parse(await readFile(path, "utf8"));
        delete state.initialVersions[foundation.name];
        await json(path, state);
      },
    ],
  ]) {
    const unsafe = await scenario(name, mutate, /publication|Prerelease|Required public package/u);
    assert.notEqual(unsafe.result.status, 0);
    await assert.rejects(readFile(unsafe.marker), { code: "ENOENT" });
  }

  const publish = await scenario(
    "publish",
    async (root) => {
      await json(join(root, "packages/engineering-foundation/package.json"), {
        ...foundation,
        version: "0.17.0-rc.0",
        publishConfig: { registry: registryUrl },
      });
    },
    /^\n$/u,
  );
  assert.equal(publish.result.status, 0, `${publish.result.stdout}\n${publish.result.stderr}`);
  assert.equal(await readFile(publish.marker, "utf8"), "changeset publish");
  assert.match(
    await readFile(join(publish.root, "command-shim.marker"), "utf8"),
    /^pnpm changeset publish$/mu,
  );
});
